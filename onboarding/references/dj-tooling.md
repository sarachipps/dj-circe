# DJ tooling on this machine — orchestrator reference

This is a companion file to your SOUL. When the user asks about setting
up a tool, wiring an MCP server, or making a write against Google
Workspace / Jira / Confluence / Gmail — read the relevant section here
first. It captures how these tools are wired at Dow Jones, which OAuth
flows exist, which org-policy assumptions do and don't apply, and the
failure modes that have burned people before.

The file lives in your profile directory (`~/.hermes/profiles/<you>/`
or `~/.hermes/` if you are the default profile) next to your SOUL and
CHANGELOG. Circe drops it there at onboarding time; it is not something
the user hand-crafts.

---

## 1. The model provider — Bedrock/Mantle

You are running against DJ's **Bedrock-Mantle proxy**, not direct AWS
Bedrock. Mantle accepts a long-lived bearer token issued by DJ's Okta
portal and forwards Anthropic Messages API calls to AWS Bedrock. The
token is called an **ABSK token** — a ~170-character string beginning
`ABSK`.

- Portal: `https://pub-prod-bedrock-access-hub.ohi.onservo.com` (also
  reachable through the Okta "Bedrock Access Hub (NCU)" app tile).
- **The token is displayed exactly once at creation.** After that the
  portal shows only status/expiry and a "Regenerate Key" button.
  Regenerating invalidates the previous key. If the user has Claude
  Code working, the same token is already in
  `~/.claude/settings.json` under `AWS_BEARER_TOKEN_BEDROCK` — reuse
  it, do not regenerate.
- Your `.env` needs exactly one line: `ANTHROPIC_API_KEY=<the ABSK
  value>`. Do NOT copy `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_REGION_NAME`, or `AWS_BEARER_TOKEN_BEDROCK` — those are
  decorative on the `dj-bedrock` path.
- Your `config.yaml` selects the provider:
  ```yaml
  model:
    default: anthropic.claude-sonnet-5
    provider: dj-bedrock
  providers:
    dj-bedrock:
      base_url: https://bedrock-mantle.us-east-1.api.aws/anthropic
      key_env: ANTHROPIC_API_KEY
      api_mode: anthropic_messages
  ```
- Cap: $150/user/day. Support: `#tech-coding-assistants` Slack or
  `SAP-AI@dowjones.com`.

### Verifying Bedrock is working

```bash
hermes -p <profile> chat -q "reply only: works"
```

Should reply in a few seconds. If it doesn't:

| Symptom | Cause | Fix |
|---|---|---|
| `Could not resolve authentication method` | `.env` empty/missing, or at the wrong path | `hermes config env-path` shows which `.env` Hermes is loading |
| `401 Invalid bearer token` | Token rotated or revoked | Regenerate at the portal, update both `~/.claude/settings.json` and Hermes `.env` |
| `400 model not found` | Model name wrong for entitlement | Try `anthropic.claude-sonnet-5` before `anthropic.claude-opus-4-7`; never use raw Anthropic names like `claude-3-5-sonnet-20241022` |

### Ordering note

`hermes mcp add ... --auth oauth` makes a live model call during OAuth
registration to enumerate the server's tools. That model call needs
`dj-bedrock` already configured. Bedrock first, MCPs second — always.

---

## 2. Glean MCP — `glean_default`

DJ company knowledge: indexed Gmail, Outlook, Slack, Drive, Confluence,
Jira, meeting transcripts, employee directory. **Read-only** on most DJ
accounts; writes are enabled per-account/per-group on Glean's side and
are missing for most users.

Fallback for Google Workspace writes: use §4 below.

### Config

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

- Host is `dowjones-be.glean.com` (DJ's Glean backend, not the
  marketing subdomain).
- Pin `mcp-remote@0.1.38`. Later versions may or may not work; test
  before bumping.

### OAuth

**Cannot be driven from an agent tool call.** Ask the user to run, in
their own terminal:

```bash
hermes -p <profile> mcp login glean_default
```

A browser opens for Glean OAuth consent. Tokens cache in
`~/.mcp-auth/mcp-remote-<version>/` and are **shared across profiles**
because `mcp-remote` (not Hermes) owns the cache. Grants expire ~7 days.

### Verify

```bash
hermes -p <profile> mcp test glean_default
```

Expected: `✓ Connected`, ~12 tools (User Activity, Doc Reader, Gemini
Web Search x3, Meeting Lookup, Gmail Search, Outlook Search, Code
Search, Employee Search, Glean Search, Doc Reader By URL).

### Known failure: OAuth flap

Symptom: 4-attempt-every-5-minute retry burst. Grant expired.

```bash
mv ~/.mcp-auth ~/.mcp-auth.bak-$(date +%Y%m%d-%H%M%S)
hermes -p <profile> mcp test glean_default   # re-triggers OAuth
```

---

## 3. Atlassian MCP — `atlassian` (Jira + Confluence via Rovo)

DJ Jira and Confluence via Atlassian's Rovo MCP. Direct HTTPS + OAuth
SSO — not `mcp-remote`.

### Prereqs

- Rovo activated on DJ Atlassian, Beta AI features enabled.
- **API-token auth is BLOCKED at DJ** pending governance
  (COLLABHR-4922, COLLABHR-5278). Only SSO/OAuth allowed. Do not
  suggest switching to API tokens.
- If OAuth returns "not authorized for Rovo MCP," that is admin-side
  gating; escalate via COLLABHR-4922 (Preetha Peter's team).

### Config

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

- Endpoint is `/v1/mcp`. Do **not** use `/v1/sse` — the SSE variant is
  deprecated.
- Subset is 18 of 31 tools, approved read-only starter set. Excluded
  are 6 Jira writes, 4 Confluence writes, and 3 comment-read tools.

### The write-path pitfall

`hermes config set mcp_servers.atlassian.tools.include '[...]'` DOES
NOT produce a YAML list. It stores the JSON blob as a quoted scalar.
Hermes's name-filter then treats that scalar as one tool name that
matches nothing → MCP registers with zero tools on the next session.

**Correct write paths:**
- File write to `config.yaml` directly (agent may do this).
- OR user pastes the block via `hermes config edit`.

**Wrong path:** `hermes config set` with a JSON string arg. Silent
failure.

### OAuth + Verify

```bash
hermes -p <profile> mcp login atlassian    # user runs in their terminal
hermes -p <profile> mcp test atlassian     # expect ✓ Connected, ~18 tools
```

If the count is 31, the include filter didn't apply — the `config set`
pitfall above bit.

---

## 4. Google Workspace MCP — `google-workspace` (the DJ writes path)

**Gmail send/draft, Google Docs create/edit, Sheets update, Calendar
create, Drive read/write.** This is **the DJ-approved write path** for
Google Workspace.

### The important thing to understand

You may have absorbed — from older skill notes, from DJ Google Cloud
org-policy documentation, from a colleague's warning — the idea that
Google Workspace MCPs at DJ require a user-owned OAuth client in a
personal GCP project, and that DJ org policy blocks those, so writes
are impossible. **That was true for one class of Google Workspace
MCPs. It is not true for this one.**

The `gemini-cli-extensions/workspace` MCP handles OAuth internally
with **Google's own OAuth client** (project `338689075775-...`).
Refresh flows through a Google-run Cloud Function at
`google-workspace-extension.geminicli.com/refreshToken`. No personal
GCP project is created, no user-owned OAuth client is registered, no
DJ Google Cloud org policy is triggered. The DJ org-policy blockers
you may have heard about do not apply to this MCP.

If a colleague or an older SOUL/skill tells you to avoid the
`google-workspace` skill or MCP path on DJ policy grounds, that
guidance is stale for this specific server. Propose enabling it.

### Which profile hosts this MCP

**A dedicated writes profile, not the main operator profile.** The
convention is one profile per functional role: the writes profile owns
everything that mutates external state, and other profiles delegate to
it when they need to write. Sara's writes profile is `wesley`.

Do NOT wire this MCP on the main operator profile — writes accumulate
tool inventory and blast radius; keep them behind a boundary.

### Config

```yaml
mcp_servers:
  google-workspace:
    command: npx
    args:
      - -y
      - github:gemini-cli-extensions/workspace#preview-YYYY-MM-DD
    enabled: true
```

- Pin to the current weekly `preview-YYYY-MM-DD` tag. Do NOT pin
  semver (`v0.0.x` is effectively abandoned upstream). Bump the pin
  roughly weekly; the latest tag lives at
  `github.com/gemini-cli-extensions/workspace` in the tags list.
- **Do NOT pass `--auth oauth`** when adding this MCP. The MCP
  handles its own OAuth internally; passing `--auth oauth` makes
  Hermes try to broker an OAuth flow the MCP is already handling,
  which 401s.

### First-run OAuth

Unlike Glean and Atlassian, this MCP has **no upfront `mcp login`
command**. The OAuth trigger is the **first tool call** — the MCP
prints an auth URL to stderr, the user clicks through in a browser,
and Google's Cloud Function does the token exchange.

**Recommended first-trigger tool:** `people_getMe` (identity read, no
side effects). Instruct the user to watch stderr for the auth URL.

**The Google consent screen names the app "Gemini CLI Workspace
Extension"** — that is Google's app registration, not DJ's, not
phishing. Confirm this with the user before they consent so they
don't back out at the last screen.

### Verify

```bash
hermes -p <profile> mcp test google-workspace
```

Expected: `✓ Connected`, **56 tools** (verified 2026-07-16). No
`tools.include` filter by default — the writes profile gets the
full superset.

### Known failure: upstream scope-drift outage

April 2026 had ~2 weeks of hard-blocked consent (upstream issues #333
and #323 in `gemini-cli-extensions/workspace`). If OAuth consent
starts failing across the board, that is an upstream outage — not
fixable locally. Fallback: Glean read tools for reads, manual browser
for writes until upstream ships a fix.

---

## 5. Post-install verification (every profile)

For each profile with configured MCPs, all three must return clean:

1. `hermes -p <profile> mcp list` — every configured MCP appears with
   status `✓ enabled`.
2. `hermes -p <profile> mcp test <name>` — for each MCP: expected tool
   count, no auth errors.
3. **Session restart** — MCP tool changes do NOT apply mid-conversation.
   Tools aren't actually available until the next session (`/reset` in
   an ongoing session, or a new invocation).

Only after all three come back clean is the wire-up done.

---

## 6. Change-log discipline

Every approved MCP wire-up logs to the affected profile's own
`CHANGELOG.md`:

- Default profile: `~/.hermes/CHANGELOG.md`
- Other profiles: `~/.hermes/profiles/<name>/CHANGELOG.md`

Format: one line, no paragraphs.

```
YYYY-MM-DD HH:MM | Added <server> MCP (<url>, <auth_mode>) on <profile> — <tool subset summary> | approved-by: <name>
```

Never log to another profile's CHANGELOG from a different profile's
context. Each profile logs its own changes.

---

## 7. What NOT to do

- ❌ `hermes mcp add <name> --auth oauth` from a non-interactive shell
  or agent tool call. OAuth needs a real TTY + browser. Propose the
  command; let the user run it from their terminal.
- ❌ `hermes config set mcp_servers.<name>.tools.include '[...]'`.
  Silently breaks the MCP. Use `hermes config edit` or a file write.
- ❌ Regenerating the Bedrock token during Hermes setup when Claude
  Code is already using it. Copy the existing token, don't regenerate.
- ❌ Copying all four AWS-flavored env vars from an existing `.env`
  when onboarding a new colleague. Only `ANTHROPIC_API_KEY` is
  required.
- ❌ Passing `--auth oauth` to the Google Workspace MCP add command.
  It self-manages OAuth.
- ❌ Wiring the Google Workspace MCP on the main operator profile.
  Use a dedicated writes profile.
- ❌ Attempting the Atlassian API-token auth path. Blocked at DJ
  pending governance (COLLABHR-4922).
- ❌ Declining Google Workspace writes on DJ org-policy grounds —
  that reasoning applies to user-owned OAuth clients in personal GCP
  projects, not to the `gemini-cli-extensions/workspace` MCP which
  uses Google's own OAuth client.

---

## 8. Related deep-dive references (on-disk, for the maintainer)

An orchestrator generally doesn't need to read these mid-turn, but
they exist if a session hits an edge case not covered above:

- `~/.hermes/skills/productivity/dj-mcp-integrations/SKILL.md`
- `.../references/dj-bedrock-mantle-setup.md`
- `.../references/dj-mcp-catalog.md`
- `.../references/gemini-cli-workspace-mcp-rdc-guide.md`
- `.../references/mcp-remote-oauth-debugging.md`
