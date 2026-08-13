# OAG Rembr Pilot

This runbook covers the Rembr pilot on `oag-aks-dev`. It supports Claude Code, OpenCode, and Codex.

## Access Model

- Endpoint: `https://rembr.20.31.109.30.nip.io/mcp`
- Network allowlist: `213.252.201.137/32`, `88.119.11.24/32`, and `154.61.60.178/32`
- Pilot users outside Alex's current public IP must connect FortiClient using `VNO - All Traffic`.
- Existing individual canary users keep separate personal tenants and keys. Never migrate their memories into another tenant implicitly.
- The OAG Second Brain uses a separate shared tenant with one user-bound key per participant. Personal memories are private to that user, deliberate shared memories are tenant-wide, and named team audiences use restricted projects with explicit members.
- One person uses the same key across their own Claude Code, OpenCode, and Codex installations. Never reuse a key between people or tenants.
- Hosted console: `https://rembr-console.20.31.109.30.nip.io`
- The hosted console uses the same user-bound API key as the clients. It keeps the key only in a bounded in-memory server session and starts in read-only mode.

The endpoint uses a public Azure load balancer with an ingress source allowlist. It is network-restricted, not a private endpoint.

## Readiness Gates

Complete these before provisioning real users:

- Move the live Rembr Kubernetes resources into the `ai-infra-poc` repository as the durable deployment source.
- Deploy a reviewed Rembr image containing the Azure health fix and current server changes.
- Change `AZURE_OPENAI_API_VERSION` from `2024-02-01` to `2024-10-21`.
- Set `RATE_LIMIT_DISABLED=false` and verify the selected per-user plan under expected recall and distillation traffic.
- Keep the maintenance worker stopped until its mutation behavior is separately approved for pilot data.
- Take and validate a PostgreSQL backup immediately before onboarding.
- Verify `/health`, authenticated MCP initialization, memory create/search/delete, TLS, ingress allowlisting, and source-IP preservation.
- Finish a clean Windows install/update/uninstall test for each client from a disposable user profile.
- Define pilot support, key revocation, backup frequency, incident response, and the pilot end date.

## Administrator Provisioning

### First-user canary

Provision one person only for the initial canary. Do not provision another user until all of these checks pass:

- install from a fresh clone of the private repository
- authenticate and recall successfully from each selected client
- create a harmless memory in one client, recall it from another client, then delete it
- confirm the capture log contains no repeated authentication, rate-limit, or distillation failures
- confirm the MCP and PostgreSQL pods remain ready with no unexpected restarts
- take a PostgreSQL backup before provisioning and retain it throughout the canary

If authentication, isolation, capture, or recall fails, revoke the canary key and pause onboarding.

Use `provision-pilot-user.ps1` for an isolated personal pilot tenant. The script refuses to issue another active key for an existing email unless `-AllowAdditionalKey` is supplied for an intentional rotation. Use `rembr-mcp/scripts/provision-shared-tenant.mjs` for the separate OAG Second Brain tenant only after its full audience matrix passes.

```powershell
.\scripts\provision-pilot-user.ps1 `
  -Name "Pilot User" `
  -Email "pilot.user@oag.com" `
  -Plan pro
```

The script:

- requires Kubernetes context `oag-aks-dev-admin`
- reads `API_KEY_SECRET` without displaying it
- stores only an HMAC-SHA256 key hash in PostgreSQL
- creates or updates the person's tenant and explicit plan
- displays the plaintext API key once after the database write succeeds

Deliver the key through an approved secret-sharing channel. Do not send it in ordinary Teams chat or email.

### Existing canary key rotation

Do not revoke an active canary key before the replacement has been installed and verified. Preserve the tenant ID and all existing memories.

1. Take and validate a PostgreSQL backup. Record the canary tenant's memory count and active-key count without reading plaintext credentials.
2. Run `provision-pilot-user.ps1` for the existing email with `-AllowAdditionalKey` and a unique `-KeyName`. Write the replacement only to an approved ignored environment file or display it once for immediate secure delivery.
3. Verify the replacement key returns authenticated MCP initialization and can recall an existing canary memory before changing the user's setup.
4. Deliver the replacement through an approved one-time secret channel. Ask the user to replace only `REMBR_API_KEY`, retain `REMBR_URL`, keep file permissions at `600`, restart clients, recall an existing memory, and create/recall one harmless canary.
5. After the user confirms the replacement works, revoke only the old key hash. Verify it returns HTTP 401 while the replacement still succeeds and the tenant memory count is unchanged.

Keep the deployment's existing `API_KEY_SECRET` stable during this overlap. Rotating that global HMAC secret invalidates existing keys before a coordinated client cutover.

## User Installation

### Hosted console

Connect FortiClient using `VNO - All Traffic` unless using an explicitly allowed IP, then open `https://rembr-console.20.31.109.30.nip.io` and sign in with your personal Rembr API key. The initial hosted rollout is read-only. Signing out invalidates only that browser session, and a pod restart invalidates all console sessions.

The console does not require repository access or local client installation. Never paste the API key anywhere except the console sign-in form or the approved client installer prompt.

### Agent clients

Prerequisites:

- Windows developer machine
- Git, Node.js, and npm
- the selected clients installed
- read access to the private `oag-rembr` Azure DevOps repository
- FortiClient `VNO - All Traffic` connected unless using an explicitly allowed IP
- personal Rembr API key from the pilot administrator

Clone the repository to a stable path because the OpenCode plugin loads from this clone:

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\OAG" | Out-Null
git clone https://oagaviation@dev.azure.com/oagaviation/ai-catalyst/_git/oag-rembr "$env:LOCALAPPDATA\OAG\rembr"
Set-Location "$env:LOCALAPPDATA\OAG\rembr"
```

Install all three clients:

```powershell
.\scripts\install-pilot-windows.ps1
```

Or install selected clients:

```powershell
.\scripts\install-pilot-windows.ps1 -Clients ClaudeCode,OpenCode
```

The installer prompts for the API key so it does not appear in shell history. It validates network access and authentication, builds the local packages, installs the Claude and Codex marketplace plugins, and creates an OpenCode global plugin shim without rewriting the user's existing OpenCode configuration.

The installer stores `REMBR_API_KEY` and related settings as Windows user environment variables. This is plaintext in the user's profile and is accessible to processes running as that user. It must not be used on a shared Windows account.

After installation:

1. Restart every selected client.
2. In Codex, review and trust the Rembr plugin hooks when prompted.
3. Start a fresh session and verify first-prompt recall is visible.
4. Store a harmless test memory, recall it from another client, then delete it.

## Updating

```powershell
Set-Location "$env:LOCALAPPDATA\OAG\rembr"
git pull --ff-only
.\scripts\install-pilot-windows.ps1
```

Release versions must be incremented before rollout so Claude and Codex replace cached plugin snapshots. Restart all clients after an update.

## Uninstalling

```powershell
Set-Location "$env:LOCALAPPDATA\OAG\rembr"
.\scripts\install-pilot-windows.ps1 -Uninstall
```

This removes the selected plugins, marketplace registrations, OpenCode shim, and Rembr user environment variables. Use `-Clients` to remove only selected clients.

## Support Evidence

- Client capture log: `%USERPROFILE%\.rembr\capture.log`
- Endpoint health: `https://rembr.20.31.109.30.nip.io/health`
- Hosted console: `https://rembr-console.20.31.109.30.nip.io`
- Never include the API key in screenshots, tickets, logs, or support messages.
- Revoke the person's active API keys immediately when they leave the pilot or report a suspected leak.
