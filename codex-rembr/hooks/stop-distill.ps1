$ErrorActionPreference = "Stop"

function Write-HookResult {
    @{ continue = $true } | ConvertTo-Json -Compress
}

if ($env:REMBR_CAPTURE_DISABLE) {
    Write-HookResult
    exit 0
}

$stateDir = if ($env:REMBR_STATE_DIR) { $env:REMBR_STATE_DIR } else { Join-Path $env:USERPROFILE ".rembr" }
$logPath = if ($env:REMBR_LOG) { $env:REMBR_LOG } else { Join-Path $stateDir "capture.log" }

function Add-Log {
    param([string] $Message)
    try {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content -LiteralPath $logPath -Value "$stamp codex-hook $Message"
    } catch {
        # Hook logging must never block Codex.
    }
}

try {
    $stdin = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($stdin)) {
        Add-Log "hook received empty stdin"
        Write-HookResult
        exit 0
    }

    $event = $stdin | ConvertFrom-Json
    $eventName = [string] $event.hook_event_name
    $isForce = $eventName -eq "PreCompact"
    $transcriptPath = [string] $event.transcript_path
    if ([string]::IsNullOrWhiteSpace($transcriptPath) -or -not (Test-Path -LiteralPath $transcriptPath)) {
        Add-Log "$eventName hook missing readable transcript_path"
        Write-HookResult
        exit 0
    }

    $pluginRoot = $env:PLUGIN_ROOT
    if ([string]::IsNullOrWhiteSpace($pluginRoot)) { $pluginRoot = Split-Path -Parent $PSScriptRoot }
    $distiller = Join-Path $pluginRoot "dist\distill-cli.js"
    if (-not (Test-Path -LiteralPath $distiller)) {
        Add-Log "distiller not found: $distiller"
        Write-HookResult
        exit 0
    }

    if ($isForce) {
        $env:REMBR_DISTILL_MIN_RECORDS = "1"
    } elseif (-not $env:REMBR_DISTILL_MIN_RECORDS) {
        $env:REMBR_DISTILL_MIN_RECORDS = "80"
    }

    # Do not start cooldown for a transcript that the distiller will debounce.
    if (-not $isForce) {
        $fileName = [IO.Path]::GetFileNameWithoutExtension($transcriptPath)
        $sessionMatch = [regex]::Match($fileName, '([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$', 'IgnoreCase')
        if ($sessionMatch.Success) {
            $sessionId = $sessionMatch.Groups[1].Value
            $totalRecords = (Get-Content -LiteralPath $transcriptPath | Measure-Object -Line).Lines
            $cursorPath = Join-Path (Join-Path $stateDir "cursors") "codex-$sessionId"
            $cursor = 0
            if (Test-Path -LiteralPath $cursorPath) {
                $parsedCursor = 0
                if ([int]::TryParse((Get-Content -LiteralPath $cursorPath -Raw).Trim(), [ref] $parsedCursor)) {
                    $cursor = if ($parsedCursor -le $totalRecords) { $parsedCursor } else { 0 }
                }
            }
            $newRecords = $totalRecords - $cursor
            if ($newRecords -lt [int] $env:REMBR_DISTILL_MIN_RECORDS) {
                Add-Log "Stop hook debounce preflight: $newRecords new records < $env:REMBR_DISTILL_MIN_RECORDS, session $sessionId"
                Write-HookResult
                exit 0
            }
        }
    }

    $cooldownSeconds = if ($env:REMBR_DISTILL_COOLDOWN_SECONDS) { [int] $env:REMBR_DISTILL_COOLDOWN_SECONDS } else { 900 }
    $sha = [Security.Cryptography.SHA256]::Create()
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($transcriptPath))
    $hash = ([BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
    $cooldownDir = Join-Path $stateDir "codex-distill-cooldown"
    $cooldownFile = Join-Path $cooldownDir $hash
    if (-not $isForce -and (Test-Path -LiteralPath $cooldownFile)) {
        $last = (Get-Item -LiteralPath $cooldownFile).LastWriteTimeUtc
        $age = ([DateTime]::UtcNow - $last).TotalSeconds
        if ($age -lt $cooldownSeconds) {
            Add-Log "Stop hook skipped by cooldown: age=$([int] $age)s threshold=${cooldownSeconds}s transcript=$transcriptPath"
            Write-HookResult
            exit 0
        }
    }

    New-Item -ItemType Directory -Force -Path $cooldownDir | Out-Null
    Set-Content -LiteralPath $cooldownFile -Value ([DateTime]::UtcNow.ToString("o")) -Encoding ASCII

    $encodedTranscript = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($transcriptPath))
    $encodedLog = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($logPath))
    $encodedEvent = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($(if ($eventName) { $eventName } else { "unknown" })))
    $encodedMinRecords = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($env:REMBR_DISTILL_MIN_RECORDS))
    $encodedPluginRoot = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pluginRoot))
    $runner = @"
`$ErrorActionPreference = "Continue"
`$transcriptPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("$encodedTranscript"))
`$logPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("$encodedLog"))
`$eventName = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("$encodedEvent"))
`$pluginRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("$encodedPluginRoot"))
`$env:REMBR_DISTILL_MIN_RECORDS = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("$encodedMinRecords"))
function Add-Log([string] `$Message) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent `$logPath) | Out-Null
    `$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath `$logPath -Value "`$stamp codex-hook-bg `$Message"
  } catch {}
}
try {
  Set-Location -LiteralPath `$pluginRoot
  `$distiller = Join-Path `$pluginRoot "dist\distill-cli.js"
  Add-Log "`$eventName distiller started: min_records=`$env:REMBR_DISTILL_MIN_RECORDS transcript=`$transcriptPath"
  `$output = & node `$distiller `$transcriptPath 2>&1
  `$exitCode = `$LASTEXITCODE
  if (`$exitCode -ne 0) {
    `$msg = (`$output -join " ")
    if (`$msg.Length -gt 300) { `$msg = `$msg.Substring(0, 300) }
    Add-Log "`$eventName distiller exited `${exitCode}: `$msg"
  } else {
    Add-Log "`$eventName distiller completed: `$transcriptPath"
  }
} catch {
  Add-Log "`$eventName distiller failed: `$(`$_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath `$PSCommandPath -Force -ErrorAction SilentlyContinue
}
"@
    $runnerPath = Join-Path $env:TEMP "codex-rembr-stop-distill-$hash.ps1"
    Set-Content -LiteralPath $runnerPath -Value $runner -Encoding UTF8
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $runnerPath) -WindowStyle Hidden | Out-Null
    $mode = if ($isForce) { "forced" } else { "scheduled" }
    Add-Log "$eventName hook $mode background distiller: min_records=$env:REMBR_DISTILL_MIN_RECORDS cooldown=${cooldownSeconds}s transcript=$transcriptPath"
} catch {
    Add-Log "hook failed: $($_.Exception.Message)"
}

Write-HookResult
exit 0
