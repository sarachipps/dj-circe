# DJ Bedrock + MCP Setup — Reference for Automated Circe Provisioning

**Purpose:** the reference info a DJ Circe installer needs to configure
the Bedrock/Mantle model provider and the three DJ-blessed MCP servers
on any colleague's DJ-issued Mac. Not a full runbook, not a snapshot of
one machine — just the reusable per-profile patterns, config blocks,
and OAuth flows.

**Scope:**
1. **Bedrock/Mantle provider** — required on every profile before any
   MCP works.
2. **Glean MCP** (`glean_default`) — read-only company knowledge.
3. **Atlassian MCP** (`atlassian`) — Jira + Confluence via Rovo.
4. **Google Workspace MCP** (`google-workspace`) — Gmail / Docs / Calendar
   writes.

**Not in scope:** Hermes install, profile creation, Circe app build,
per-user profile fleet choices. See the Circe rebuild spec and Hermes
docs for those.

---

## Ordering — do these in sequence

1. **Bedrock provider first, on every profile.** `hermes mcp add ... --auth
   oauth` makes a live model call during OAuth registration to enumerate
   the server's tools. That model call needs `dj-bedrock` already
   configured or it will fail with `Could not resolve authentication
   method`. Configure the provider (§1) on a profile before adding any
   MCP to that profile.
2. **MCPs in any order after Bedrock is working.** Verify Bedrock with
   `hermes -p <profile> chat -q "reply only: works"` before starting MCP
   wiring.

---

## 1. Bedrock/Mantle provider — required on every profile

DJ engineers do not use direct AWS Bedrock. They use DJ's **Bedrock-Mantle
proxy** which accepts a long-lived bearer token issued by DJ's Okta portal
and forwards Anthropic Messages API calls to AWS Bedrock on the caller's
behalf.

### 1a. Token acquisition

**Portal:** `https://pub-prod-bedrock-access-hub.ohi.onservo.com` (also
reachable via the Okta **"Bedrock Access Hub (NCU)"** app tile — SSO-linked
to the same page).

1. In Okta, search for **"Bedrock Access Hub (NCU)"**. If it's not on the
   colleague's dashboard: Add Apps → App Catalog → search → Request.
2. Once approved, click the tile → lands on the portal URL.
3. Click **Create Bedrock API Key** (first time) or **Regenerate Key**
   (subsequent). A long token (`ABSK...`, ~170 chars) is shown **exactly
   once**. Copy immediately.

**The portal never re-displays the token after creation.** It only shows
IAM Username, status, expiry, and a Regenerate button. If the colleague
"can't find the ABSK token on the page," they need to check where they
stored it originally, or regenerate (which invalidates the previous key).

**Cap:** $150/user/day. **Region:** `us-east-2` default.
**Support:** `#tech-coding-assistants` Slack or `SAP-AI@dowjones.com`.

### 1b. The Claude Code preservation rule

**Ask the colleague first:** "Do you already have Claude Code working on
this machine?"

- **YES →** their Bedrock token is already in `~/.claude/settings.json`
  under `AWS_BEARER_TOKEN_BEDROCK`. **Copy that value into the Hermes
  profile's `.env`. Do NOT regenerate the token** — regeneration
  invalidates the existing key and silently breaks their Claude Code.
- **NO →** send them to the Claude Code Slack canvas first:
  `https://newscorp.enterprise.slack.com/docs/T025QN6JG/F096R3WLJJX`.
  That walks them through the Bedrock Access Hub click-through and yields
  a working `~/.claude/settings.json`. Onboard Hermes from that state.

**Rationale:** the same token serves both Claude Code and Hermes. Ordering
the setup so Claude Code lands first, then Hermes copies the value,
guarantees an idempotent path that doesn't require issuing new tokens.

### 1c. Per-profile config

**Path:** `~/.hermes/config.yaml` for the `default` profile,
`~/.hermes/profiles/<name>/config.yaml` otherwise.

Add these two blocks (or merge with existing top-level keys):

```yaml
model:
  default: anthropic.claude-sonnet-5   # or claude-opus-4-7 — depends on entitlement
  provider: dj-bedrock
providers:
  dj-bedrock:
    base_url: https://bedrock-mantle.us-east-1.api.aws/anthropic
    key_env: ANTHROPIC_API_KEY
    api_mode: anthropic_messages
```

**Path:** `~/.hermes/profiles/<name>/.env` (or `~/.hermes/.env` for
default).

Add exactly this line — nothing else:

```
ANTHROPIC_API_KEY=<the AWS_BEARER_TOKEN_BEDROCK value from ~/.claude/settings.json — long string starting ABSK, ~170 chars>
```

**Do NOT copy these other AWS-flavored vars** into the `.env` even if the
colleague sees them in existing setup docs — they are decorative on the
`dj-bedrock` path (they'd only be read by the real AWS SigV4 Bedrock
adapter, which is not in use):

- `AWS_BEARER_TOKEN_BEDROCK`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION_NAME`

Only `ANTHROPIC_API_KEY` is required. The one-line minimal `.env` is the
correct shape.

### 1d. Verify Bedrock is working

```bash
hermes -p <profile> chat -q "reply only: works"
```

Should respond in a few seconds with "works" or similar.

**For an installer verifying before proceeding**, scrub inherited env vars
so you know the config alone is sufficient:

```bash
env -i HOME="$HOME" PATH="$HOME/.local/bin:/usr/bin:/bin" \
    hermes -p <profile> chat -q "reply only: works"
```

If it doesn't respond cleanly under `env -i`, something in the ambient
environment is silently making it work — the profile config is
incomplete, and moving to MCP setup will fail.

### 1e. Mantle routing quirk (for anyone reproducing calls outside Hermes)

The Anthropic SDK POSTs to `/anthropic/chat/completions` (OpenAI-shaped
path), NOT `/anthropic/v1/messages`. Request body is still Anthropic
Messages shape. Authorization header is a plain `Authorization: Bearer
<token>` — not `x-api-key`, not SigV4. Hitting the wrong path returns 401
"Invalid bearer token" even with a valid token.

Full anatomy of the token, endpoint routing, and reproduction procedure:
`~/.hermes/skills/productivity/dj-mcp-integrations/references/dj-bedrock-mantle-setup.md`.

### 1f. Bedrock failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Could not resolve authentication method. Expected either api_key or auth_token to be set…` | `ANTHROPIC_API_KEY` empty/missing, or `.env` not at the expected path. | Run `hermes config env-path` to see which `.env` Hermes is loading. SDK client-construction error, no request was sent. |
| `403` on first real request | Token present but Mantle rejected it. Stale token, or entitlement doesn't cover requested model. | Try `default: anthropic.claude-sonnet-5` (broader entitlement) before `claude-opus-4-7`. If still fails, escalate `#tech-coding-assistants`. |
| `400 "model not found"` | Model name wrong for entitlement. | Ask platform team which model IDs the token has access to; varies per user. Common valid names: `anthropic.claude-sonnet-5`, `anthropic.claude-opus-4-7`. Do NOT use raw Anthropic-API names like `claude-3-5-sonnet-20241022`. |

---

## 2. Glean MCP (`glean_default`)

DJ company knowledge — indexed Gmail, Outlook, Slack, Drive, Confluence,
Jira, meeting transcripts, employee directory. Read-only.

### 2a. Config block

**Path:** the target profile's `config.yaml`. Merge into an existing
`mcp_servers:` map or create the key if absent.

```yaml
mcp_servers:
  glean_default:
    command: npx
    args:
      - -y
      - mcp-remote@0.1.38
      - https://dowjones-be.glean.com/mcp/default
    enabled: true
```

**Notes:**
- `dowjones-be.glean.com` is DJ's Glean backend host — the company-specific
  subdomain, not the marketing-facing one.
- Transport is stdio via the `mcp-remote@0.1.38` npx bridge. The bridge is
  a locally-spawned subprocess that terminates HTTPS to Glean's remote MCP
  endpoint and handles the OAuth dance.
- Pin `mcp-remote` to `@0.1.38` — later versions may or may not work with
  DJ Glean; when bumping, test explicitly.

### 2b. OAuth handshake

**Cannot be driven from an agent tool call — needs a real terminal with
browser handoff.**

The colleague runs, from their own interactive terminal:

```bash
hermes -p <profile> mcp login glean_default
```

A browser opens for Glean OAuth consent. Tokens cache in
`~/.mcp-auth/mcp-remote-<version>/` — **shared across profiles** because
`mcp-remote` (not Hermes) owns this cache.

Grants expire ~7 days. See §2d for refresh.

### 2c. Verification

```bash
hermes -p <profile> mcp test glean_default
```

Expected: `✓ Connected`, tool count > 0. Read tools available (~12): User
Activity, Doc Reader, Gemini Web Search (x3), Meeting Lookup, Gmail Search,
Outlook Search, Code Search, Employee Search, Glean Search, Doc Reader By
URL.

### 2d. Known failure mode: OAuth flap

**Symptom:** 4-attempt-every-5-minute retry burst
(`_MAX_INITIAL_CONNECT_RETRIES=3` + `_PARKED_RETRY_INTERVAL=300s`). Grant
expired.

**Fix:**

```bash
mv ~/.mcp-auth ~/.mcp-auth.bak-$(date +%Y%m%d-%H%M%S)
hermes -p <profile> mcp test glean_default    # re-triggers OAuth
```

### 2e. Write status

**Writes NOT enabled** on Glean for most DJ accounts. Gmail draft/send,
Google Docs create, Sheets update, and Calendar create are missing tools
via `glean_default` MCP. This is a per-account/per-group enablement gap on
Glean's side, not a Hermes issue.

**Fallback for writes:** use the Google Workspace MCP on a dedicated
profile (§4). That's DJ-approved and sidesteps the Glean enablement gap
entirely.

---

## 3. Atlassian MCP — Jira + Confluence via Rovo

DJ Jira and Confluence, via Atlassian's Rovo MCP. Direct HTTP + OAuth SSO,
not `mcp-remote`.

### 3a. Prereqs (org-side; verify before wiring)

- Rovo activated on DJ Atlassian
- Beta AI features enabled
- Colleague has Jira Cloud with AI features
- **API-token auth is BLOCKED at DJ** pending governance
  (COLLABHR-4922, COLLABHR-5278). Only SSO/OAuth allowed. Do not attempt
  to switch to API tokens.

If OAuth returns "not authorized for Rovo MCP," that's admin-side gating.
Escalate via COLLABHR-4922 (Preetha Peter's team).

### 3b. Config block

**Path:** the target profile's `config.yaml`.

```yaml
mcp_servers:
  atlassian:
    url: https://mcp.atlassian.com/v1/mcp
    auth: oauth
    enabled: true
    tools:
      include:
        # System / discovery (4)
        - atlassianUserInfo
        - getAccessibleAtlassianResources
        - getVisibleJiraProjects
        - lookupJiraAccountId
        # Jira read (7)
        - getJiraIssue
        - searchJiraIssuesUsingJql
        - getTransitionsForJiraIssue
        - getJiraIssueRemoteIssueLinks
        - getIssueLinkTypes
        - getJiraProjectIssueTypesMetadata
        - getJiraIssueTypeMetaWithFields
        # Confluence read (5)
        - getConfluencePage
        - searchConfluenceUsingCql
        - getConfluenceSpaces
        - getPagesInConfluenceSpace
        - getConfluencePageDescendants
        # Rovo unified (2)
        - search
        - fetch
```

**Endpoint:** `https://mcp.atlassian.com/v1/mcp`. Do **not** use
`https://mcp.atlassian.com/v1/sse` — the SSE variant is deprecated per
internal `#tech-coding-assistants` Slack.

**Tool subset:** 18 of 31 tools — approved read-only starter set. Excluded
are 6 Jira writes (edit / create / comment / transition / worklog / link),
4 Confluence writes (create page / update page / create comment / create
inline comment), and 3 comment-read tools (footer / inline / child).
Comment-read tools are borderline useful — easy to re-enable if a
workflow needs them.

**Writing this subset from an installer — the pitfall:**

`hermes config set mcp_servers.atlassian.tools.include '[...]'` DOES NOT
produce a YAML list. It stores the JSON blob as a quoted scalar.
`_normalize_name_filter` then treats that scalar as one tool name that
matches nothing → MCP registers with zero tools on the next session.

**Correct write paths:**
- The installer writes the full YAML block above via file write (agent
  can `patch` or `write_file` on `~/.hermes/profiles/<name>/config.yaml`
  — this is allowed).
- OR the colleague pastes the block via `hermes config edit`.

**Wrong path:** `hermes config set` with a JSON string arg. Silent failure.

**Verify after write:** re-read the YAML and confirm `tools.include:` is a
real list of strings (each starting with `- `), not a quoted scalar on
one line.

### 3c. OAuth handshake

**Cannot be driven from an agent tool call.**

Colleague runs, from their own interactive terminal:

```bash
hermes -p <profile> mcp login atlassian
```

Browser opens for Atlassian SSO. OAuth tokens cache per-profile at
`~/.hermes/profiles/<name>/` — each profile that wants Atlassian needs its
own handshake.

### 3d. Verification

```bash
hermes -p <profile> mcp test atlassian
```

Expected: `✓ Connected`, ~18 tools discovered (matches the include list).
If the count is 31, the include filter didn't apply — check §3b for the
write-path pitfall.

---

## 4. Google Workspace MCP (`google-workspace`)

Gmail send/draft, Google Docs create/edit, Sheets update, Calendar create,
Drive read/write. **The DJ-approved write path** for Google Workspace,
because it sidesteps the DJ Google Cloud org policy that blocks user-owned
OAuth clients.

### 4a. Which profile hosts this MCP

**Recommendation: a dedicated writes profile, not the main operator
profile.** Sara's convention is one profile per functional role; the
writes profile owns everything that mutates external state, and other
profiles delegate to it when they need to write. The installer should ask
the colleague which profile name to use (Sara's is `wesley`) or default to
a sensible name.

Do NOT wire this MCP on the main operator profile — writes accumulate
tool inventory and blast radius; keep them behind a boundary.

### 4b. Config block

**Path:** the target writes-profile `config.yaml`.

```yaml
mcp_servers:
  google-workspace:
    command: npx
    args:
      - -y
      - github:gemini-cli-extensions/workspace#preview-2026-04-27
    enabled: true
```

**Pin discipline:** always pin to the current weekly
`preview-YYYY-MM-DD` tag. Do **not** pin semver — `v0.0.x` is effectively
abandoned upstream. Bump the pin roughly weekly; the installer should
either accept the pin as a parameter or look up the latest weekly preview
tag from the GitHub repo `gemini-cli-extensions/workspace` at run time.

**Do NOT pass `--auth oauth`** when adding this MCP. The MCP handles its
own OAuth internally with Google's own OAuth client
(project `338689075775-...`). Passing `--auth oauth` makes Hermes try to
broker an OAuth flow the MCP is already handling, which 401s.

### 4c. First-run OAuth

Unlike Glean and Atlassian, this MCP has **no upfront OAuth handshake
command**. The OAuth trigger is the **first tool call** — the MCP prints
an auth URL to stderr, the colleague clicks through in a browser, and
Google-run refresh happens via a Cloud Function at
`google-workspace-extension.geminicli.com/refreshToken`.

**Recommended first-trigger tool:** `people_getMe` (identity read, no side
effects). The installer should invoke it and instruct the colleague to
watch stderr for the auth URL.

**Consent screen names the app "Gemini CLI Workspace Extension"** —
that's Google's app registration, not DJ's, not phishing. Confirm this
with the colleague before they consent so they don't back out.

### 4d. Verification

```bash
hermes -p <profile> mcp test google-workspace
```

Expected: `✓ Connected`, **56 tools** discovered (verified 2026-07-16 —
the RDC doc's "~100 tools" estimate was wrong).

No `tools.include` filter is applied by default — the writes profile
should have the full superset.

### 4e. Known failure mode: upstream scope-drift outage

April 2026 had ~2 weeks of hard-blocked consent (upstream issues #333,
#323 in `gemini-cli-extensions/workspace`). If OAuth consent starts
failing across the board, that's an upstream outage — not fixable
locally. Fallback: Glean reads (redundant, but read-only) + manual
browser for writes until upstream ships a fix.

---

## 5. Post-install verification (every profile)

For each profile the installer configured, all three must return clean:

1. **`hermes -p <profile> mcp list`** — every configured MCP appears with
   status `✓ enabled`.
2. **`hermes -p <profile> mcp test <name>`** — for each MCP: expected tool
   count, no auth errors.
3. **Session restart** — MCP tool changes do NOT apply mid-conversation.
   Tools aren't actually available until the next session (`/reset` in an
   ongoing session, or a new invocation).

Only after all three come back clean is the wire-up done.

---

## 6. Change-log discipline (for the installer)

Every approved MCP wire-up should log to the affected profile's own
`CHANGELOG.md`:

- **Default profile:** `~/.hermes/CHANGELOG.md`
- **Other profiles:** `~/.hermes/profiles/<name>/CHANGELOG.md`

**Format:** one line per change, no paragraphs.

```
YYYY-MM-DD HH:MM | Added <server> MCP (<url>, <auth_mode>) on <profile> — <tool subset summary> | approved-by: <colleague-name>
```

**Never log to another profile's CHANGELOG** from a different profile's
context. Each profile logs its own changes.

---

## 7. Summary of what NOT to do

- ❌ `hermes mcp add <name> --auth oauth` from a non-interactive shell /
  agent tool call. OAuth needs a real TTY + browser. Always propose the
  command for the colleague to run from their terminal.
- ❌ `hermes config set mcp_servers.<name>.tools.include '[...]'`. Silently
  breaks the MCP. Use `hermes config edit` or a file write instead.
- ❌ Regenerating the Bedrock token during Hermes setup when Claude Code is
  already using it. Copy the existing token, don't regenerate.
- ❌ Copying all four AWS-flavored env vars from an existing `.env` when
  onboarding a fresh colleague. Only `ANTHROPIC_API_KEY` is required.
- ❌ Passing `--auth oauth` to the Google Workspace MCP add command. It
  self-manages OAuth.
- ❌ Wiring the Google Workspace MCP on the colleague's main operator
  profile. Use a dedicated writes profile.
- ❌ Attempting the Atlassian API-token auth path. Blocked at DJ pending
  governance (COLLABHR-4922).

---

## 8. Related reference material on-disk

Deeper context is captured in these skill files. An installer probably
doesn't need to read them at runtime, but the developer maintaining the
installer should:

- `~/.hermes/skills/productivity/dj-mcp-integrations/SKILL.md` — master
  skill with wiring rules, endpoint choices, and troubleshooting.
- `.../references/dj-bedrock-mantle-setup.md` — Bedrock provider deep-dive
  including base64 anatomy of the ABSK token, Mantle endpoint routing,
  and the "verify with `env -i` before sending colleague instructions"
  lesson from Travis's onboarding.
- `.../references/dj-mcp-catalog.md` — per-MCP catalog with governance
  state and future-candidate MCPs.
- `.../references/gemini-cli-workspace-mcp-rdc-guide.md` — Google
  Workspace MCP install guide and failure-mode recovery.
- `.../references/mcp-remote-oauth-debugging.md` — deep-dive on flapping /
  stuck `mcp-remote`-wrapped servers (relevant for Glean).
