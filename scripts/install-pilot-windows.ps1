[CmdletBinding()]
param(
    [ValidateSet("ClaudeCode", "OpenCode", "Codex")]
    [string[]] $Clients = @("ClaudeCode", "OpenCode", "Codex"),
    [string] $RembrUrl = "https://rembr.20.31.109.30.nip.io/mcp",
    [switch] $SkipConnectivityCheck,
    [switch] $Uninstall,
    [ValidateSet("User", "Process")]
    [string] $EnvironmentTarget = "User",
    [string] $UserHome = $HOME
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Assert-Command {
    param([string] $Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Invoke-External {
    param(
        [string] $Command,
        [string[]] $Arguments,
        [string] $Description
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Read-ApiKey {
    $existing = [Environment]::GetEnvironmentVariable("REMBR_API_KEY", "Process")
    if (-not [string]::IsNullOrWhiteSpace($existing)) { return $existing }

    $secure = Read-Host "Enter your personal Rembr API key" -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Test-RembrConnection {
    param([string] $Url, [string] $ApiKey)

    $mcpUri = [Uri] $Url
    $healthBuilder = [UriBuilder] $mcpUri
    $healthBuilder.Path = $healthBuilder.Path -replace '/mcp/?$', '/health'
    try {
        $health = Invoke-WebRequest -Uri $healthBuilder.Uri -UseBasicParsing -TimeoutSec 15
        if ($health.StatusCode -ne 200) { throw "health returned HTTP $($health.StatusCode)" }
    } catch {
        throw "Rembr is not reachable. Connect FortiClient using 'VNO - All Traffic' and retry. $($_.Exception.Message)"
    }

    $body = @{
        jsonrpc = "2.0"
        id = 1
        method = "initialize"
        params = @{
            protocolVersion = "2025-06-18"
            capabilities = @{}
            clientInfo = @{ name = "oag-rembr-pilot-installer"; version = "1.0.0" }
        }
    } | ConvertTo-Json -Depth 5 -Compress
    try {
        $response = Invoke-WebRequest -Uri $mcpUri -Method Post -UseBasicParsing -TimeoutSec 15 -Headers @{
            "x-api-key" = $ApiKey
            "Accept" = "application/json, text/event-stream"
        } -ContentType "application/json" -Body $body
        if ($response.StatusCode -ne 200) { throw "initialize returned HTTP $($response.StatusCode)" }
        if ($response.Content.TrimStart().StartsWith("{")) {
            $payload = $response.Content | ConvertFrom-Json
            if ($payload.error) { throw "initialize returned JSON-RPC error $($payload.error.code): $($payload.error.message)" }
        }
    } catch {
        throw "Rembr rejected the supplied API key or MCP initialization failed. $($_.Exception.Message)"
    }
}

$settings = @{
    REMBR_URL = $RembrUrl
    REMBR_API_KEY = $null
    REMBR_MIN_SIMILARITY = "0.3"
    REMBR_RECALL_LIMIT = "5"
    REMBR_MAX_RECALL = "5"
    REMBR_TIMEOUT_MS = "15000"
}
$environmentVariableTarget = [EnvironmentVariableTarget] [Enum]::Parse(
    [EnvironmentVariableTarget],
    $EnvironmentTarget
)

if ($Uninstall) {
    if ($Clients -contains "ClaudeCode" -and (Get-Command claude -ErrorAction SilentlyContinue)) {
        $installed = (& claude plugin list --json | Out-String | ConvertFrom-Json)
        if (@($installed) | Where-Object { $_.id -eq "rembr@rembr" }) {
            Invoke-External "claude" @("plugin", "uninstall", "rembr@rembr", "--scope", "user", "--yes") "Claude plugin uninstall"
        }
        $marketplaces = (& claude plugin marketplace list --json | Out-String | ConvertFrom-Json)
        if (@($marketplaces) | Where-Object { $_.name -eq "rembr" }) {
            Invoke-External "claude" @("plugin", "marketplace", "remove", "rembr", "--scope", "user") "Claude marketplace removal"
        }
    }

    if ($Clients -contains "OpenCode") {
        $shimPath = Join-Path $UserHome ".config\opencode\plugins\rembr.js"
        if (Test-Path -LiteralPath $shimPath) {
            Remove-Item -LiteralPath $shimPath -Force
        }
    }

    if ($Clients -contains "Codex" -and (Get-Command codex -ErrorAction SilentlyContinue)) {
        $plugins = (& codex plugin list --json | Out-String | ConvertFrom-Json).installed
        if (@($plugins) | Where-Object { $_.name -eq "rembr" -or $_.id -eq "rembr@oag-rembr" -or $_.selector -eq "rembr@oag-rembr" }) {
            Invoke-External "codex" @("plugin", "remove", "rembr@oag-rembr", "--json") "Codex plugin removal"
        }
        $marketplaces = (& codex plugin marketplace list --json | Out-String | ConvertFrom-Json).marketplaces
        if (@($marketplaces) | Where-Object { $_.name -eq "oag-rembr" }) {
            Invoke-External "codex" @("plugin", "marketplace", "remove", "oag-rembr", "--json") "Codex marketplace removal"
        }
    }

    foreach ($name in $settings.Keys) {
        [Environment]::SetEnvironmentVariable($name, $null, $environmentVariableTarget)
        if ($EnvironmentTarget -eq "Process") {
            Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        }
    }
    Write-Output "Rembr pilot uninstallation completed for: $($Clients -join ', ')."
    return
}

Assert-Command "git"
Assert-Command "node"
Assert-Command "npm.cmd"
$nodeMajor = [int] ((& node --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required; found $(& node --version)."
}

$apiKey = Read-ApiKey
if ($apiKey -notmatch '^mb_live_[A-Za-z0-9]+$') {
    throw "The API key does not have the expected mb_live_ format."
}
if (-not $SkipConnectivityCheck) {
    Test-RembrConnection -Url $RembrUrl -ApiKey $apiKey
}

$settings.REMBR_API_KEY = $apiKey
foreach ($entry in $settings.GetEnumerator()) {
    Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
}

if ($Clients -contains "ClaudeCode") {
    Assert-Command "claude"
    $marketplaces = (& claude plugin marketplace list --json | Out-String | ConvertFrom-Json)
    $marketplace = @($marketplaces) | Where-Object { $_.name -eq "rembr" }
    if ($marketplace) {
        if ($marketplace.source -eq "directory" -and [IO.Path]::GetFullPath($marketplace.path) -ne [IO.Path]::GetFullPath($repoRoot)) {
            throw "Claude marketplace 'rembr' already points to '$($marketplace.path)', not this clone."
        }
        Invoke-External "claude" @("plugin", "marketplace", "update", "rembr") "Claude marketplace update"
    } else {
        Invoke-External "claude" @("plugin", "marketplace", "add", $repoRoot, "--scope", "user") "Claude marketplace registration"
    }

    $installed = (& claude plugin list --json | Out-String | ConvertFrom-Json)
    if (@($installed) | Where-Object { $_.id -eq "rembr@rembr" }) {
        Invoke-External "claude" @("plugin", "update", "rembr@rembr", "--scope", "user") "Claude plugin update"
    } else {
        Invoke-External "claude" @("plugin", "install", "rembr@rembr", "--scope", "user") "Claude plugin install"
    }
}

if ($Clients -contains "OpenCode") {
    Assert-Command "opencode"
    $packageRoot = Join-Path $repoRoot "opencode-rembr"
    Invoke-External "npm.cmd" @("ci", "--prefix", $packageRoot) "OpenCode plugin dependency install"
    Invoke-External "npm.cmd" @("run", "build", "--prefix", $packageRoot) "OpenCode plugin build"

    $distPlugin = Join-Path $packageRoot "dist\plugin.js"
    if (-not (Test-Path -LiteralPath $distPlugin)) { throw "OpenCode build did not create $distPlugin." }
    Invoke-External "npm.cmd" @("prune", "--omit=dev", "--prefix", $packageRoot) "OpenCode plugin production dependency prune"
    $pluginUri = ([Uri] $distPlugin).AbsoluteUri
    $globalPluginDir = Join-Path $UserHome ".config\opencode\plugins"
    New-Item -ItemType Directory -Force -Path $globalPluginDir | Out-Null
    $shimPath = Join-Path $globalPluginDir "rembr.js"
    Set-Content -LiteralPath $shimPath -Encoding UTF8 -Value "export { default } from `"$pluginUri`""
}

if ($Clients -contains "Codex") {
    Assert-Command "codex"
    $packageRoot = Join-Path $repoRoot "codex-rembr"
    Invoke-External "npm.cmd" @("ci", "--prefix", $packageRoot) "Codex plugin dependency install"
    Invoke-External "npm.cmd" @("run", "build", "--prefix", $packageRoot) "Codex plugin build"
    foreach ($artifact in @("dist\cli.js", "dist\distill-cli.js", "dist\recall-hook-cli.js")) {
        $artifactPath = Join-Path $packageRoot $artifact
        if (-not (Test-Path -LiteralPath $artifactPath)) { throw "Codex build did not create $artifactPath." }
    }
    Invoke-External "npm.cmd" @("prune", "--omit=dev", "--prefix", $packageRoot) "Codex plugin production dependency prune"

    $marketplaces = (& codex plugin marketplace list --json | Out-String | ConvertFrom-Json).marketplaces
    if (-not (@($marketplaces) | Where-Object { $_.name -eq "oag-rembr" })) {
        Invoke-External "codex" @("plugin", "marketplace", "add", $repoRoot) "Codex marketplace registration"
    }
    Invoke-External "codex" @("plugin", "add", "rembr@oag-rembr") "Codex plugin install"
}

foreach ($entry in $settings.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, $environmentVariableTarget)
}

Write-Output "Rembr pilot installation completed for: $($Clients -join ', ')."
Write-Output "Restart the selected clients. In Codex, review and trust the Rembr plugin hooks when prompted."
