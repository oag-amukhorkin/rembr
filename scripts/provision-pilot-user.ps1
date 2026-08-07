[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string] $Name,
    [Parameter(Mandatory)]
    [string] $Email,
    [ValidateSet("free", "pro", "team", "business", "enterprise")]
    [string] $Plan = "pro",
    [string] $KeyName,
    [string] $KubeContext = "oag-aks-dev-admin",
    [string] $Namespace = "rembr",
    [switch] $AllowAdditionalKey,
    [string] $KeyOutputEnvFile,
    [string] $KeyOutputEnvName
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$bootstrapScript = Join-Path $repoRoot "rembr-mcp\scripts\bootstrap-tenant.mjs"

foreach ($command in @("kubectl", "node")) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command '$command' was not found in PATH."
    }
}
if (-not (Test-Path -LiteralPath $bootstrapScript)) {
    throw "Bootstrap script not found: $bootstrapScript"
}

if ([string]::IsNullOrWhiteSpace($KeyOutputEnvFile) -xor [string]::IsNullOrWhiteSpace($KeyOutputEnvName)) {
    throw "KeyOutputEnvFile and KeyOutputEnvName must be supplied together."
}
if ($KeyOutputEnvFile) {
    if (-not (Test-Path -LiteralPath $KeyOutputEnvFile -PathType Leaf)) {
        throw "Key output environment file not found: $KeyOutputEnvFile"
    }
    if ($KeyOutputEnvName -notmatch '^[A-Z_][A-Z0-9_]*$') {
        throw "KeyOutputEnvName must be a valid uppercase environment variable name."
    }
    if (Select-String -LiteralPath $KeyOutputEnvFile -Pattern "^$([regex]::Escape($KeyOutputEnvName))=" -Quiet) {
        throw "Environment variable $KeyOutputEnvName already exists in $KeyOutputEnvFile."
    }
}

try {
    [void] [Net.Mail.MailAddress] $Email
} catch {
    throw "Email is not valid: $Email"
}

$currentContext = (& kubectl config current-context).Trim()
if ($LASTEXITCODE -ne 0 -or $currentContext -ne $KubeContext) {
    throw "Current kubectl context is '$currentContext'; expected '$KubeContext'."
}

$emailBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Email))
$activeKeyOutput = & kubectl --context $KubeContext exec -n $Namespace deployment/postgres -- psql -v ON_ERROR_STOP=1 -U rembr -d rembr -Atc "SELECT COUNT(*) FROM api_keys WHERE tenant_id = (SELECT id FROM tenants WHERE email = convert_from(decode('$emailBase64', 'base64'), 'UTF8')) AND revoked_at IS NULL;"
if ($LASTEXITCODE -ne 0) {
    throw "Could not check existing Rembr keys for $Email."
}
$activeKeyCount = ([string] $activeKeyOutput).Trim()
if (-not $AllowAdditionalKey -and [int] $activeKeyCount -gt 0) {
    throw "Tenant $Email already has $activeKeyCount active key(s). Use -AllowAdditionalKey only for an intentional rotation."
}

$target = "$Name <$Email> on $KubeContext/$Namespace"
if (-not $PSCmdlet.ShouldProcess($target, "Create Rembr tenant plan and API key")) {
    return
}

$encodedSecret = (& kubectl --context $KubeContext get secret rembr-secrets -n $Namespace -o jsonpath="{.data.API_KEY_SECRET}").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($encodedSecret)) {
    throw "Could not read API_KEY_SECRET from $Namespace/rembr-secrets."
}
$apiKeySecret = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedSecret))
$encodedSecret = $null

if ([string]::IsNullOrWhiteSpace($KeyName)) {
    $KeyName = "pilot-$($Email.Split('@')[0])"
}

$nodeStart = [Diagnostics.ProcessStartInfo]::new()
$nodeStart.FileName = (Get-Command node).Source
$nodeStart.ArgumentList.Add($bootstrapScript)
$nodeStart.UseShellExecute = $false
$nodeStart.RedirectStandardOutput = $true
$nodeStart.RedirectStandardError = $true
$nodeStart.Environment["TENANT_NAME"] = $Name
$nodeStart.Environment["TENANT_EMAIL"] = $Email
$nodeStart.Environment["TENANT_PLAN"] = $Plan
$nodeStart.Environment["KEY_NAME"] = $KeyName
$nodeStart.Environment["API_KEY_SECRET"] = $apiKeySecret
$nodeStart.Environment["REQUIRE_NO_ACTIVE_KEYS"] = if ($AllowAdditionalKey) { "false" } else { "true" }

$nodeProcess = [Diagnostics.Process]::Start($nodeStart)
$nodeOutputTask = $nodeProcess.StandardOutput.ReadToEndAsync()
$nodeErrorTask = $nodeProcess.StandardError.ReadToEndAsync()
if (-not $nodeProcess.WaitForExit(15000)) {
    $nodeProcess.Kill($true)
    $nodeStart.Environment.Remove("API_KEY_SECRET")
    $apiKeySecret = $null
    throw "Tenant bootstrap generation timed out."
}
$sql = $nodeOutputTask.GetAwaiter().GetResult()
$keyOutput = $nodeErrorTask.GetAwaiter().GetResult()
$nodeStart.Environment.Remove("API_KEY_SECRET")
$apiKeySecret = $null
if ($nodeProcess.ExitCode -ne 0) {
    throw "Tenant bootstrap generation failed: $keyOutput"
}

$keyMatch = [regex]::Match($keyOutput, 'mb_live_[A-Za-z0-9]+')
if (-not $keyMatch.Success) {
    throw "Tenant bootstrap did not return an API key."
}

$kubectlStart = [Diagnostics.ProcessStartInfo]::new()
$kubectlStart.FileName = (Get-Command kubectl).Source
foreach ($argument in @("--context", $KubeContext, "exec", "-i", "-n", $Namespace, "deployment/postgres", "--", "psql", "-v", "ON_ERROR_STOP=1", "-U", "rembr", "-d", "rembr")) {
    $kubectlStart.ArgumentList.Add($argument)
}
$kubectlStart.UseShellExecute = $false
$kubectlStart.RedirectStandardInput = $true
$kubectlStart.RedirectStandardOutput = $true
$kubectlStart.RedirectStandardError = $true

$kubectlProcess = [Diagnostics.Process]::Start($kubectlStart)
$psqlOutputTask = $kubectlProcess.StandardOutput.ReadToEndAsync()
$psqlErrorTask = $kubectlProcess.StandardError.ReadToEndAsync()
$kubectlProcess.StandardInput.Write($sql)
$kubectlProcess.StandardInput.Close()
if (-not $kubectlProcess.WaitForExit(30000)) {
    $kubectlProcess.Kill($true)
    throw "Tenant provisioning timed out. The generated key was not displayed."
}
$psqlOutput = $psqlOutputTask.GetAwaiter().GetResult()
$psqlError = $psqlErrorTask.GetAwaiter().GetResult()
if ($kubectlProcess.ExitCode -ne 0) {
    throw "Tenant provisioning failed. The generated key was not displayed. $psqlError"
}

Write-Output "Provisioned Rembr pilot tenant: $Name <$Email>, plan $Plan."
if ($KeyOutputEnvFile) {
    Add-Content -LiteralPath $KeyOutputEnvFile -Value "$KeyOutputEnvName=$($keyMatch.Value)" -Encoding utf8
    Write-Output "Rembr API key written to environment variable $KeyOutputEnvName in the requested local file."
} else {
    Write-Host "Rembr API key (shown once):"
    Write-Host $keyMatch.Value
}
