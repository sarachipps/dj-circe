# Circe

A tiny Electron app that turns each of your Hermes profiles into a side-by-side
tile window. Backed by Claude via Dow Jones's Bedrock-Mantle endpoint.

## Prerequisites

You need **both** of these working before Circe can do anything useful:

1. **A DJ Bedrock API key.** The long `ABSK…` token issued by the DJ
   Bedrock-Mantle onboarding process.
2. **Claude Code set up on this machine.** Circe's first-run wizard reads
   `~/.claude/settings.json` and reuses `AWS_BEARER_TOKEN_BEDROCK` from
   there — no key regeneration, so your existing Claude Code stays working.

If you don't have those yet, do the Claude Code setup first:

- Slack canvas: <https://newscorp.enterprise.slack.com/docs/T025QN6JG/F096R3WLJJX>
- Confluence: <https://dowjones.atlassian.net/wiki/spaces/SFSS/pages/6559957082>

You also need:

- **Node 20+** and **npm**
- **Hermes CLI** at `~/.local/bin/hermes`. If missing:
  ```bash
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
  ```
  (The onboarding wizard can install it for you on Step 2 if it isn't there.)

## Install

```bash
git clone https://github.com/sarachipps/dj-circe.git
cd dj-circe
npm install
```

## Run

### First-run onboarding, sandboxed

Recommended for testing the wizard without touching your real agents:

```bash
npm run dev:onboarding
```

Wipes `~/.hermes-dev` and `~/.hermes-tiles-dev`, then launches Electron
against those sandbox directories. Your real `~/.hermes` profiles are
untouched. On completion you get an Orchestrator tile in the sandbox
you can chat with.

### Live run

```bash
npm start
```

Runs against `~/.hermes` and `~/.hermes-tiles`. First launch triggers the
onboarding wizard; subsequent launches open one tile per profile.

### Re-trigger the wizard on your live setup

```bash
npm run reset:onboarding
```

Flips `firstRunComplete=false` in `~/.hermes-tiles/state.json` without
touching profiles or credentials. Next `npm start` re-runs the wizard.

## Tests

```bash
npm test
```

## More docs

- [`CIRCE-ONBOARDING-DESIGN.md`](CIRCE-ONBOARDING-DESIGN.md) — wizard design
  spec, step by step
- [`DJ-HERMES-ONBOARDING.md`](DJ-HERMES-ONBOARDING.md) — manual Hermes + DJ
  Bedrock setup if you'd rather not use the wizard
- [`DJ-MCP-SETUP.md`](DJ-MCP-SETUP.md) — Glean + Atlassian MCP wiring
- [`CIRCE-WHAT-TO-BUILD.md`](CIRCE-WHAT-TO-BUILD.md) — original app spec
- [`HOME-MACHINE-SETUP.md`](HOME-MACHINE-SETUP.md) — rebuild-from-scratch spec
