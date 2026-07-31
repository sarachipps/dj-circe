# Hermes Setup at Dow Jones

Instructions for setting up Hermes Agent to run against DJ's Bedrock-Mantle endpoint (same Claude models Claude Code uses).

Verified working on 2026-07-27 against a fresh minimal profile with a scrubbed environment (`env -i`) — got a live Claude response in 3 seconds.

## Prerequisite: Claude Code must already be working

Hermes reuses the Bedrock API key from your Claude Code setup. If Claude Code isn't set up yet, do that first:

- Slack canvas walk-through: https://newscorp.enterprise.slack.com/docs/T025QN6JG/F096R3WLJJX
- Confluence: https://dowjones.atlassian.net/wiki/spaces/SFSS/pages/6559957082

That process gets you the long Bedrock API key (starts with `ABSK`, ~171 chars) and puts it into `~/.claude/settings.json` as `AWS_BEARER_TOKEN_BEDROCK`. Once Claude Code works, you have everything you need.

## Setup steps

### 1. Install Hermes

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

Verify:

```bash
hermes --version
```

Should print `Hermes Agent v0.18.x` or newer. If `command not found`, add `~/.local/bin` to your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 2. Create a profile

```bash
hermes profile create default
```

### 3. Write the config

Replace `~/.hermes/profiles/default/config.yaml` with exactly this:

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

### 4. Write the .env

Grab the Bedrock API key from `~/.claude/settings.json` (the `AWS_BEARER_TOKEN_BEDROCK` value — a long string starting with `ABSK`).

Write `~/.hermes/profiles/default/.env` as **one line**:

```
ANTHROPIC_API_KEY=<paste the ABSK... value here>
```

The trailing `=` in the token is optional — leave it or strip it, both work.

That's the entire credential setup. No other env vars needed. Do NOT add `AWS_ACCESS_KEY_ID`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_SECRET_ACCESS_KEY`, or `AWS_REGION_NAME` — they're unused on this path.

### 5. Test

```bash
hermes -p default chat -q "hi"
```

Should get a Claude response in a few seconds.

## Model options

Common `default:` values to swap in `config.yaml`:

- `anthropic.claude-sonnet-5` — everyday workhorse (recommended default)
- `anthropic.claude-opus-4-7` — smarter, slower, more expensive

Or use `/model` inside a chat session to switch on the fly.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Could not resolve authentication method` | `.env` file isn't being read. Check the path is exactly `~/.hermes/profiles/default/.env` and the line starts with `ANTHROPIC_API_KEY=` (no space around `=`, no `export` prefix). |
| `Invalid bearer token` / 401 | Token was rotated somewhere else and this one's now invalid. Regenerate at https://pub-prod-bedrock-access-hub.ohi.onservo.com and update both `~/.claude/settings.json` and Hermes `.env`. |
| `command not found: hermes` | PATH issue — see step 1. |
| Circe launched from Finder shows env `(UNSET)` in marker file | Circe now reads `~/.hermes/profiles/<name>/.env` itself since the 2026-07-27 patch to `acpClient.js`. Older Circe builds need Circe launched from a shell with the env exported. |

## Where the key came from (background — Sara's history)

Sara set up Claude Code first (approved via Okta 2026-07-09). The Bedrock API key was generated at that time via the Bedrock Access Hub portal (`pub-prod-bedrock-access-hub.ohi.onservo.com`) and shown on screen once. It's stored in `~/.claude/settings.json` as `AWS_BEARER_TOKEN_BEDROCK`. When she set up Hermes on 2026-07-13, she copied that same token into Hermes' `.env` as `ANTHROPIC_API_KEY`. That's why the portal only shows an "Active" status and a "Regenerate Key" button now — the token was displayed once at creation time and never again.

## Support

- Slack: `#tech-coding-assistants`
- Email: SAP-AI@dowjones.com

## Related

- Skill: `~/.hermes/skills/productivity/dj-bedrock-mantle/SKILL.md` (byte-level token format, config internals, code-path notes)
- Skill: `~/.hermes/skills/productivity/circe-tile-app/SKILL.md` (Circe Electron tile app internals)
- DJ Confluence: [Get your Amazon Bedrock API Key](https://dowjones.atlassian.net/wiki/spaces/SFSS/pages/6559957082)
- DJ Confluence: [How to access Claude at Dow Jones](https://dowjones.atlassian.net/wiki/spaces/SFSS/pages/6558482506)
