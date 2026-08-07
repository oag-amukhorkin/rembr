# OAG Rembr Pilot

This runbook covers the initial Windows pilot for 5-10 OAG users. It supports Claude Code, OpenCode, and Codex against the Rembr deployment on `oag-aks-dev`.

## Access Model

- Endpoint: `https://rembr.20.31.109.30.nip.io/mcp`
- Network allowlist: `213.252.201.137/32` and `88.119.11.24/32`
- Pilot users outside Alex's current public IP must connect FortiClient using `VNO - All Traffic`.
- Each person receives a separate Rembr tenant and API key. Do not share a tenant between people.
- One person uses the same key across their Claude Code, OpenCode, and Codex installations.
- The console is not part of the pilot. It has no user authentication and supports only one configured server-side key.

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

Use a separate tenant per person. The script refuses to issue another active key for an existing email unless `-AllowAdditionalKey` is supplied for an intentional rotation.

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

## User Installation

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
- Never include the API key in screenshots, tickets, logs, or support messages.
- Revoke the person's active API keys immediately when they leave the pilot or report a suspected leak.
