# dj-mcp-integrations skill — design

**Status:** approved for implementation
**Date:** 2026-08-27
**Repo:** dj-circe, branch `feat/dj-onboarding`

## Problem

A colleague finishes Circe onboarding and lands at a fresh Orchestrator
tile. They've got the model plus the eleven platform toolsets Circe now
writes into `config.yaml`, but no DJ integrations — no Glean, no
Atlassian, no Google Workspace. The first time they say "pull up the
Confluence page for X" or "check my Gmail", the Orchestrator has no
capability *and* no institutional knowledge of how to acquire it.

Today the wizard's Step 6 "Let my Orchestrator help me" path writes a
five-line `first-tasks.md` telling the agent to proactively offer a
Glean + Atlassian walk-through. That's brittle for two reasons:

1. It only fires once, on session start, and only for the two
   pre-scripted integrations. Anything else (Google Workspace,
   Bedrock-on-a-new-agent) is invisible to the Orchestrator.
2. The proactive offer arrives before the user has expressed a need,
   which is exactly the kind of pushy behavior SOUL rule 4 tells the
   Orchestrator to avoid.

## Goal

Give the Orchestrator agent enough institutional knowledge — packaged
as a Hermes skill — to recognize when a user request implies a DJ
integration, propose the right setup path (add to this profile vs.
spawn a dedicated writes agent), and walk the user through the
paste-back one integration at a time.

The trigger is the agent's own judgment on capability gaps, not a
scripted onboarding step.

## Non-goals

- Automating the OAuth flows (fundamentally requires a real TTY +
  browser handoff; the paste-back pattern is the correct shape).
- Covering non-DJ integrations (Discord, Signal, Home Assistant, etc.
  — those belong on the operator's personal profiles, not the DJ
  Orchestrator).
- Managing MCP updates over time (weekly-pin bumps for Google
  Workspace, mcp-remote version drift for Glean). The skill will note
  the discipline; implementing an updater is a later concern.
- Retrofitting the skill onto existing profiles. No one but the author
  has installed Circe yet; the next `npm run dev:onboarding` run picks
  up the skill automatically, and other adopters onboard fresh.

## Delivery mechanism

The skill files ship in the Circe repo:

```
onboarding/
  skills/
    dj-mcp-integrations/
      SKILL.md
      references/
        glean.md
        atlassian.md
        google-workspace.md
        bedrock-provider.md
```

`profileWriter.createOrchestrator` gets a new step: after the profile
directory is created and `SOUL.md` written, recursively copy
`onboarding/skills/dj-mcp-integrations/` to
`<profileDir>/skills/dj-mcp-integrations/`. Hermes auto-discovers
per-profile skills, so no config change is needed.

**One-shot, at profile creation.** No sync-on-start, no periodic
refresh. If a future Circe release ships updated skill content, users
who want the update either recreate their Orchestrator or copy the
skill manually. Simple; deferred until it hurts.

## Skill content

### SKILL.md (the always-visible index)

Frontmatter:

```yaml
---
name: dj-mcp-integrations
description: >
  Use when the user's request implies a DJ integration (Glean company
  search, Confluence, Jira, Gmail, Google Docs, Sheets, Calendar,
  Drive) AND the corresponding MCP server is not already wired on this
  profile. Also covers the judgment call of whether to add the
  integration to THIS profile vs. spawning a dedicated writes profile,
  and the paste-back OAuth flow (agents cannot drive OAuth handshakes
  — the colleague must run `hermes mcp login` from their own
  terminal).
---
```

Body sections:

1. **Capability → integration map**
   - "search company knowledge / find docs / who works on X" → Glean
   - "Confluence page / Jira ticket / search JQL" → Atlassian
   - "email / calendar / Google Doc / Sheet / Drive file" → Google
     Workspace

2. **Detection check before proposing anything**
   ```bash
   hermes -p <this-profile> mcp list
   ```
   If the target MCP is present and enabled, skip setup and use it. If
   absent, this skill applies.

3. **The self-vs-dedicated-agent decision**
   Codifies SOUL rule 3:
   - **Read-only integrations** (Glean, Atlassian 18-tool subset) → add
     to this profile.
   - **Writing integrations** (Google Workspace: Gmail send, Doc/Sheet
     writes, Calendar create) → propose spawning a dedicated writes
     profile unless the user explicitly asks to enable writes on the
     Orchestrator. Skill notes the fleet convention (Sara's is
     `wesley`), suggests a sensible default name, and defers naming
     to the user.
   - "Spawn a new profile" today means proposing the exact
     `hermes profile create <name>` command as a paste-back, then
     walking Bedrock provider setup (referencing
     `bedrock-provider.md`) before the MCP wire-up. The skill does
     not attempt to automate profile creation from inside the
     Orchestrator — same TTY / permission reasons as OAuth.
   - Never spawn silently — surface the proposal, wait for approval.

4. **The paste-back pattern**
   Agents can't drive `mcp login` (needs TTY + browser). Standard
   dance:
   1. Propose the exact `hermes -p <slug> mcp add …` and `mcp login`
      commands from the relevant reference file.
   2. Wait for the user to paste them into their terminal.
   3. Verify with `hermes -p <slug> mcp test <server>`.
   4. Note that MCP tool changes require a session restart before the
      agent can use them.

5. **Reference pointers**
   - Glean specifics → `references/glean.md`
   - Atlassian specifics → `references/atlassian.md`
   - Google Workspace specifics → `references/google-workspace.md`
   - Bedrock provider (only relevant when helping spin up a new
     agent) → `references/bedrock-provider.md`

6. **Known failure modes** (one-liners with pointers to reference
   files for depth):
   - Glean OAuth flap (7-day grant expiry) → `mv ~/.mcp-auth …` fix
   - Atlassian tools.include silent-failure via `hermes config set` —
     always use file write or `hermes config edit`
   - Google Workspace weekly-pin drift — check
     `gemini-cli-extensions/workspace` for the current
     `preview-YYYY-MM-DD` tag

### references/glean.md

Condensed from `DJ-MCP-SETUP.md` §2:
- Config block (mcp-remote@0.1.38 pin, DJ-specific endpoint)
- OAuth handshake command
- Verification (`mcp test` expected tool count ~12)
- OAuth flap recovery (`mv ~/.mcp-auth …`)
- Write status note (writes aren't enabled — use Google Workspace
  MCP for writes)

### references/atlassian.md

Condensed from `DJ-MCP-SETUP.md` §3:
- The 18-tool `tools.include` subset (inline, ready to paste)
- Endpoint: `https://mcp.atlassian.com/v1/mcp` — NOT the deprecated
  `/v1/sse` variant
- **The tools.include write pitfall** — call out loudly. Never use
  `hermes config set` for the list; use file write or
  `hermes config edit`.
- OAuth handshake per-profile
- Verification (`mcp test` expected tool count 18)
- Rovo prereqs (COLLABHR-4922 gating — API tokens blocked, OAuth only)

### references/google-workspace.md

Condensed from `DJ-MCP-SETUP.md` §4:
- **Recommendation up front**: use a dedicated writes profile, not
  the Orchestrator.
- Config block (weekly-pin discipline for
  `gemini-cli-extensions/workspace#preview-YYYY-MM-DD`)
- **No `--auth oauth` flag** — the MCP self-manages OAuth.
- First-run OAuth trigger via the first tool call (`people_getMe`
  recommended); consent screen says "Gemini CLI Workspace Extension".
- Verification (`mcp test` expected tool count 56)
- Upstream outage failure mode (April 2026 scope-drift incident)

### references/bedrock-provider.md

Only referenced when the Orchestrator is helping spin up a *new*
agent, not for wiring MCPs on its own profile (its own Bedrock config
was written by the wizard). Content mirrors `DJ-MCP-SETUP.md` §1:
- Ordering: Bedrock first on every new profile, THEN any MCP
- Claude Code preservation rule (reuse `AWS_BEARER_TOKEN_BEDROCK`
  from `~/.claude/settings.json`; do NOT regenerate)
- Minimal config.yaml `providers:` block
- Minimal `.env` (one line, `ANTHROPIC_API_KEY=…`)
- Verify with `env -i` before proceeding
- Failure-mode table (auth resolution error, 403, model-not-found)

## Interaction with existing wizard behavior

The wizard's Step 6 offers three MCP-wiring choices today:

1. **"Let my Orchestrator help me"** (recommended) — writes
   `first-tasks.md` that scripts a proactive Glean + Atlassian offer.
2. **"Show me the commands now"** — inline paste-back panel.
3. **"Skip"** — no seed, no cards.

With the skill in place, option 1's `first-tasks.md` becomes redundant
and slightly conflicting (proactive push vs. capability-gap trigger).
Rewrite it to a shorter, capability-neutral seed:

> On session start, greet the user in-voice, then wait for them to
> lead. When their request implies a DJ integration that isn't wired
> yet, use the `dj-mcp-integrations` skill to propose setup. Don't
> volunteer setup pre-emptively.

That preserves the "warm greeting, no push" spirit while replacing
scripted setup with skill-driven judgment.

Option 2 (inline paste-back panel) stays unchanged — it's for people
who prefer upfront wiring over emergent. The wizard writes the same
commands as the skill's references would, so the two paths converge
on the same on-disk state.

Option 3 (skip) stays unchanged.

## Testing

- **Manual, sandboxed:** `npm run dev:onboarding` → complete the
  wizard picking "Let my Orchestrator help me" → open the Orchestrator
  tile → ask something that implies an integration (e.g. "search
  Confluence for the RDC style guide"). The Orchestrator should
  recognize Atlassian isn't wired, invoke the skill, and propose the
  paste-back commands.
- **Unit-ish:** a test that after `createOrchestrator({...})`,
  `<profileDir>/skills/dj-mcp-integrations/SKILL.md` exists.

## Open questions

None blocking. Deferred:
- Skill updates over time (sync mechanism if the reference files
  drift). Reassess after two or three colleagues are on the tool.
- Whether the wizard's Step 6 option 2 (inline paste-back) should be
  removed once the skill covers the same ground with less UI. Keep
  both for now; both are cheap.

## Out of scope for this spec

The next spec (implementation plan) will define:
- Exact SKILL.md body text
- Exact reference file bodies
- The `profileWriter.createOrchestrator` diff
- The `first-tasks.md` rewrite
- Any tests
