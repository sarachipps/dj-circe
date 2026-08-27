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

- **Node 20+** and **npm.** If you don't have them, on macOS the easiest
  path is Homebrew.

  First, check whether Homebrew is already installed:
  ```bash
  brew --version
  ```
  If that prints a version, skip ahead to `brew install node`. If it
  says `command not found`, install Homebrew:
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```
  Follow the on-screen prompts (it'll ask for your password and may take
  a few minutes). When it finishes, it prints two "Next steps" commands
  to add `brew` to your PATH — **run those exactly as printed**, then
  open a fresh terminal.

  Then install Node:
  ```bash
  brew install node
  ```
  Verify:
  ```bash
  node --version   # v20.x or newer
  npm --version
  ```

  Prefer not to use Homebrew? Grab the LTS installer from
  <https://nodejs.org> — the `.pkg` puts both `node` and `npm` on your
  PATH.
- **Hermes.** You don't have to install it yourself — Step 2 of the
  onboarding wizard detects Hermes and installs it in place if it's
  missing. If you'd rather do it up front:
  ```bash
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
  ```

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
