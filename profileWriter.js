const fs = require('node:fs');
const path = require('node:path');
const child_process = require('node:child_process');

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function runHermes({ bin, args, hermesHome, spawnImpl }) {
  return new Promise((resolve) => {
    const spawn = spawnImpl || child_process.spawn;
    let child;
    try {
      child = spawn(bin, args, {
        env: { ...process.env, HERMES_HOME: hermesHome, HERMES_ACCEPT_HOOKS: '1' },
      });
    } catch (err) {
      resolve({ code: -1, stderr: err.message || String(err), error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => resolve({ code: -1, stderr: err.message, error: err }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function createOrchestrator({
  slug,
  oneLiner,
  soulMd,
  avatarBytes,
  avatarSource,
  hermesHome,
  hermesBin,
  spawnImpl,
}) {
  // 1. Create the profile via hermes CLI.
  const create = await runHermes({
    bin: hermesBin,
    args: ['profile', 'create', slug, '--description', oneLiner],
    hermesHome,
    spawnImpl,
  });
  if (create.code !== 0) {
    return {
      ok: false,
      rolledBack: false,
      error:
        (create.stderr && create.stderr.trim()) ||
        (create.stdout && create.stdout.trim()) ||
        `hermes profile create exited ${create.code}`,
    };
  }

  const profileDir = path.join(hermesHome, 'profiles', slug);

  // 2. Write SOUL.md, avatar.png, CHANGELOG.md.
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    let soulOut = soulMd;
    if (avatarSource) {
      const marker = '<!-- avatar-source:';
      if (soulOut.includes(marker)) {
        soulOut = soulOut.replace(
          /<!-- avatar-source:[^>]*-->/,
          `<!-- avatar-source: ${avatarSource} -->`,
        );
      } else {
        soulOut = soulOut.trimEnd() + `\n\n<!-- avatar-source: ${avatarSource} -->\n`;
      }
    }
    // Append the DJ-tooling pointer section (idempotent via marker).
    soulOut = patchSoulWithDjToolingPointer(soulOut).content;
    fs.writeFileSync(path.join(profileDir, 'SOUL.md'), soulOut);
    fs.writeFileSync(path.join(profileDir, 'avatar.png'), avatarBytes);
    fs.writeFileSync(path.join(profileDir, 'CHANGELOG.md'), '# CHANGELOG\n');
    return { ok: true, profileDir };
  } catch (writeErr) {
    // 3. Rollback via hermes profile delete.
    await runHermes({
      bin: hermesBin,
      args: ['profile', 'delete', slug, '--yes'],
      hermesHome,
      spawnImpl,
    });
    return {
      ok: false,
      rolledBack: true,
      error: writeErr.message || String(writeErr),
    };
  }
}

async function writeFirstTasks(profileDir, content) {
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'first-tasks.md'), content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

const DJ_TOOLING_REFERENCE_PATH = path.join(
  __dirname,
  'onboarding',
  'references',
  'dj-tooling.md',
);

// SOUL section that points the orchestrator at dj-tooling.md. Wrapped in
// stable HTML-comment markers so patchSoulWithDjToolingPointer can detect
// whether an existing SOUL already has it and stay idempotent.
const DJ_TOOLING_POINTER_START = '<!-- circe:dj-tooling-pointer v1 -->';
const DJ_TOOLING_POINTER_END = '<!-- /circe:dj-tooling-pointer -->';
const DJ_TOOLING_POINTER_SECTION =
  `${DJ_TOOLING_POINTER_START}\n` +
  '\n' +
  '## DJ tooling — read `dj-tooling.md` before answering\n' +
  '\n' +
  'A file called `dj-tooling.md` sits next to this SOUL in your profile\n' +
  'directory. It documents how Dow Jones wires the model provider\n' +
  '(Bedrock/Mantle) and the three approved MCP servers (Glean,\n' +
  'Atlassian, Google Workspace) — exact config blocks, OAuth flows,\n' +
  'per-server failure modes, and org-policy caveats.\n' +
  '\n' +
  '**Open that file first** — before answering, planning, or proposing\n' +
  'commands — whenever the user asks about any of these:\n' +
  '\n' +
  '- Glean, `glean_default`, `mcp-remote`, Glean OAuth, Glean flap\n' +
  '- Atlassian, Jira, Confluence, Rovo, `mcp.atlassian.com`\n' +
  '- Google Workspace, Google Docs, Gmail, Google Calendar, Sheets,\n' +
  '  Drive writes, `gemini-cli-extensions/workspace`\n' +
  '- Bedrock, Bedrock-Mantle, ABSK token, `dj-bedrock` provider,\n' +
  '  `ANTHROPIC_API_KEY`, Bedrock Access Hub, `pub-prod-bedrock-access-hub`\n' +
  '- Adding an MCP server, wiring a tool, `hermes mcp add`,\n' +
  '  `hermes mcp login`, `hermes mcp test`\n' +
  '\n' +
  'One load-bearing correction: Google Workspace writes at DJ go\n' +
  'through `gemini-cli-extensions/workspace`. That MCP uses Google\'s\n' +
  'own OAuth client and a Google-run Cloud Function for refresh — no\n' +
  'personal GCP project, no user-owned OAuth client. The DJ Google\n' +
  'Cloud org-policy blockers you may have heard about **do not apply**\n' +
  'to that server. If an older skill or memory tells you to avoid it,\n' +
  'that guidance is stale.\n' +
  '\n' +
  `${DJ_TOOLING_POINTER_END}\n`;

function soulHasDjToolingPointer(soulMd) {
  return typeof soulMd === 'string' && soulMd.includes(DJ_TOOLING_POINTER_START);
}

// Append the DJ-tooling pointer section to a SOUL if it's not already
// present. Returns { changed, content }. Avoids editing existing prose —
// only inserts, and only once (idempotent by marker).
function patchSoulWithDjToolingPointer(soulMd) {
  if (soulHasDjToolingPointer(soulMd)) {
    return { changed: false, content: soulMd };
  }
  // Insert before any trailing HTML-comment metadata (e.g. avatar-source,
  // circe:orchestrator version tag) so those stay at the very bottom.
  const trimmed = soulMd.replace(/\s+$/, '');
  const trailingCommentMatch = trimmed.match(/(?:\n<!--[^>]*-->\s*)+$/);
  if (trailingCommentMatch) {
    const before = trimmed.slice(0, trailingCommentMatch.index);
    const trailing = trimmed.slice(trailingCommentMatch.index);
    return {
      changed: true,
      content: `${before}\n\n${DJ_TOOLING_POINTER_SECTION}${trailing}\n`,
    };
  }
  return { changed: true, content: `${trimmed}\n\n${DJ_TOOLING_POINTER_SECTION}`.trimEnd() + '\n' };
}

// Marker-wrapped addendum for orchestrators onboarded BEFORE the upstream
// SOUL template rewrite. Adds the three sections that the pre-v2 template
// lacked: 'Creating an agent' (six-reasons + never-clone-SOUL, fixes the
// copy-paste-specialist bug), 'The network' (roster the orchestrator
// maintains as specialists appear), 'Where you live' (Circe tile context).
//
// Fresh orchestrators skip this: the v2 template body they were rendered
// from already contains this material, marked by `<!-- circe:orchestrator v2 -->`.
const ORCHESTRATOR_ADDENDUM_START = '<!-- circe:orchestrator-addendum v1 -->';
const ORCHESTRATOR_ADDENDUM_END = '<!-- /circe:orchestrator-addendum -->';
const ORCHESTRATOR_V2_MARKER = '<!-- circe:orchestrator v2 -->';
const ORCHESTRATOR_ADDENDUM_SECTION =
  `${ORCHESTRATOR_ADDENDUM_START}\n` +
  '\n' +
  '## Creating an agent\n' +
  '\n' +
  'A specialist earns its place from work that has already happened. Do not go\n' +
  'looking for a reason to create one. An agent is worth creating only when it\n' +
  'has its own reason to exist:\n' +
  '\n' +
  '- a different domain of expertise\n' +
  '- a different model\n' +
  '- a different tool set\n' +
  '- a different memory boundary\n' +
  '- a different permission level\n' +
  '- a different user or access boundary\n' +
  '\n' +
  '"It would be neat" is not on that list. One command system, one coordinator,\n' +
  'specialists that earned their place.\n' +
  '\n' +
  '**How to create one:**\n' +
  '\n' +
  '1. Propose it. Name the domain in one sentence, name the agent, and say\n' +
  '   whether it writes code.\n' +
  '2. **Wait for an actual reply.** Your own proposal is not consent. Do not\n' +
  '   create in the same turn you propose in.\n' +
  '3. Create exactly one agent per confirmation. "Set me up for engineering\n' +
  '   work" does not authorise four agents.\n' +
  '4. **Never clone your own SOUL.** Each specialist gets its own identity:\n' +
  '   its own name from the fandom, its own one-liner, its own SOUL body\n' +
  '   written for its actual role — different from yours. Copy-paste is how a\n' +
  '   fleet ends up looking like six of you with different filenames. Circe\n' +
  '   renders each tile from its own `avatar.png` and its own SOUL heading;\n' +
  '   if two profiles share those, they share a face on the desktop. Fetch a\n' +
  '   fresh `avatar.png` (Wikipedia lead image or the equivalent) for the\n' +
  '   specialist. Never reuse yours.\n' +
  '5. Write the file set that a Hermes profile needs. `hermes profile create\n' +
  '   <slug>` makes the directory; you fill it in:\n' +
  '   - `SOUL.md` — the specialist\'s identity, its voice, its mandate. NOT a\n' +
  '     copy of this file. Write it fresh from the character\'s known\n' +
  '     behaviour and the role they will play.\n' +
  '   - `avatar.png` — a 512×512 image, distinct from yours.\n' +
  '   - `config.yaml` — model, provider, and toolset scoped to what the\n' +
  '     specialist actually needs. Prune the base toolset to their role; do\n' +
  '     not ship them the full stack under a different name.\n' +
  '   - `.env` — credentials for the specialist\'s model provider.\n' +
  '   - `CHANGELOG.md` — start it, then log every governance change here.\n' +
  '6. Tell them it exists and what it is for.\n' +
  '\n' +
  '**Pacing.** Do not create six agents because they described six activities.\n' +
  'Propose, agree, create one, let them see it. A network assembled in one\n' +
  'burst is one they did not choose.\n' +
  '\n' +
  '## The network\n' +
  '\n' +
  'As you create a specialist, record it here: its name, the one domain it\n' +
  'owns, and a one-line description — nothing more elaborate than that.\n' +
  '\n' +
  'Keep it current. Add an entry the moment a specialist exists, and update or\n' +
  'remove one the moment its job changes. This is the only place you see the\n' +
  'whole crew at once, and routing work to the right agent depends on it\n' +
  'staying accurate.\n' +
  '\n' +
  'Treat a specialist\'s report on its own work as a self-report, not verified\n' +
  'fact — check it when the stakes are real.\n' +
  '\n' +
  '## Where you live\n' +
  '\n' +
  'You run inside **Circe**, a desktop tile app. Every profile in this fleet —\n' +
  'including yours — appears as its own tile on the user\'s desktop, rendered\n' +
  'from that profile\'s `avatar.png` and the first heading of its `SOUL.md`.\n' +
  'Circe watches `~/.hermes/profiles/` and opens a tile for any new profile\n' +
  'that lands there.\n' +
  '\n' +
  'Circe also has a per-tile access-mode button in the header: 🔒 Locked\n' +
  '(auto-deny writes), ⛔ Ask (approve per request), 🔓 Unlocked (auto-allow).\n' +
  'Your default is **⛔ Ask** — the user sees every write attempt at first.\n' +
  '\n' +
  '- When a write is denied, say so plainly and stop. Don\'t retry, don\'t\n' +
  '  route around it.\n' +
  '- Reads (planning, drafting, searching) are always allowed. Do them freely\n' +
  '  while the gate is locked.\n' +
  '- Batch related writes into as few tool calls as reasonable so the user\n' +
  '  isn\'t clicking through a card per line.\n' +
  '\n' +
  `${ORCHESTRATOR_ADDENDUM_END}\n`;

function soulHasOrchestratorAddendum(soulMd) {
  if (typeof soulMd !== 'string') return false;
  // Either the fresh v2 template marker OR the addendum block marker signals
  // that this SOUL already carries the material.
  return (
    soulMd.includes(ORCHESTRATOR_ADDENDUM_START) ||
    soulMd.includes(ORCHESTRATOR_V2_MARKER)
  );
}

// Insert the orchestrator-addendum block if the SOUL doesn't already carry
// the v2 material (either via the fresh-template v2 marker or a prior
// addendum). Idempotent by marker; inserts before trailing HTML-comment
// metadata so avatar-source and orchestrator-version tags stay at the
// bottom.
function patchOrchestratorSoulWithAddendum(soulMd) {
  if (soulHasOrchestratorAddendum(soulMd)) {
    return { changed: false, content: soulMd };
  }
  const trimmed = soulMd.replace(/\s+$/, '');
  const trailingCommentMatch = trimmed.match(/(?:\n<!--[^>]*-->\s*)+$/);
  if (trailingCommentMatch) {
    const before = trimmed.slice(0, trailingCommentMatch.index);
    const trailing = trimmed.slice(trailingCommentMatch.index);
    return {
      changed: true,
      content: `${before}\n\n${ORCHESTRATOR_ADDENDUM_SECTION}${trailing}\n`,
    };
  }
  return {
    changed: true,
    content: `${trimmed}\n\n${ORCHESTRATOR_ADDENDUM_SECTION}`.trimEnd() + '\n',
  };
}

async function writeDjToolingReference({ profileDir, sourcePath }) {
  try {
    const src = sourcePath || DJ_TOOLING_REFERENCE_PATH;
    const content = fs.readFileSync(src, 'utf8');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'dj-tooling.md'), content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

const CONFIG_DEFAULTS_PATH = path.join(
  __dirname,
  'onboarding',
  'config-defaults.yaml',
);

// The provider/toolset block is code-generated (rather than living in
// config-defaults.yaml) because it names DJ-specific values — the
// Bedrock-Mantle base URL, the dj-bedrock provider, the toolset for a
// fresh orchestrator. If we later grow to support more provider paths
// (direct Bedrock SigV4, personal Anthropic keys), this is the block
// that varies. `config-defaults.yaml` stays reusable across all of them.
function providerBlockYaml() {
  return (
    'platform_toolsets:\n' +
    '  cli:\n' +
    '    - clarify\n' +
    '    - code_execution\n' +
    '    - cronjob\n' +
    '    - delegation\n' +
    '    - file\n' +
    '    - kanban\n' +
    '    - memory\n' +
    '    - session_search\n' +
    '    - skills\n' +
    '    - terminal\n' +
    '    - todo\n' +
    '    - vision\n' +
    '    - web\n' +
    'model:\n' +
    '  default: anthropic.claude-sonnet-5\n' +
    '  provider: dj-bedrock\n' +
    'providers:\n' +
    '  dj-bedrock:\n' +
    '    base_url: https://bedrock-mantle.us-east-1.api.aws/anthropic\n' +
    '    key_env: ANTHROPIC_API_KEY\n' +
    '    api_mode: anthropic_messages\n'
  );
}

async function writeBedrockConfig({ profileDir, apiKey, defaultsPath }) {
  // Compose config.yaml from two sources:
  //   1. Provider block (code-generated) — DJ-specific model/toolset/provider.
  //   2. Perf/reliability defaults (file) — reasoning_effort, compression,
  //      prompt_caching, tool_loop_guardrails, memory/delegation tuning.
  // Distilled from Sara's hand-tuned Picard profile so every new
  // orchestrator starts snappy without needing to hand-tune first.
  const defaultsSrc = defaultsPath || CONFIG_DEFAULTS_PATH;
  let defaults;
  try {
    defaults = fs.readFileSync(defaultsSrc, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read config defaults: ${err.message || err}` };
  }
  const yaml = providerBlockYaml() + defaults;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'config.yaml'), yaml);
    fs.writeFileSync(path.join(profileDir, '.env'), `ANTHROPIC_API_KEY=${apiKey}\n`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Remove the pointer section (if present) from a SOUL. Complement of
// patchSoulWithDjToolingPointer — used when pruning dj-tooling from a
// non-orchestrator profile that got the pointer via a prior over-broad
// backfill. Idempotent by marker.
function stripDjToolingPointer(soulMd) {
  if (!soulHasDjToolingPointer(soulMd)) {
    return { changed: false, content: soulMd };
  }
  const startIdx = soulMd.indexOf(DJ_TOOLING_POINTER_START);
  const endMarker = DJ_TOOLING_POINTER_END;
  const endIdx = soulMd.indexOf(endMarker, startIdx);
  if (endIdx === -1) {
    // Marker unbalanced; leave content alone rather than mangle it.
    return { changed: false, content: soulMd };
  }
  // Cut the block plus its trailing newlines so we don't leave a stray gap.
  const before = soulMd.slice(0, startIdx).replace(/\n{2,}$/, '\n\n');
  const after = soulMd.slice(endIdx + endMarker.length).replace(/^\n+/, '');
  const content = `${before.replace(/\s+$/, '')}\n${after ? `\n${after}` : '\n'}`;
  return { changed: true, content };
}

// Refresh the DJ-tooling reference and SOUL pointer on the ORCHESTRATOR
// profile only. Specialist profiles never need this — the orchestrator is
// the one that wires MCP servers and provider config; specialists get
// spun up by the orchestrator with their own SOUL and don't run these
// setup flows. Returns a summary for logging.
async function refreshOrchestratorReferences({ hermesHome, orchestratorProfile, sourcePath }) {
  const summary = {
    profile: orchestratorProfile,
    referenceWritten: false,
    soulPatched: false,
  };
  const profileDir = path.join(hermesHome, 'profiles', orchestratorProfile);
  const refRes = await writeDjToolingReference({ profileDir, sourcePath });
  if (refRes.ok) summary.referenceWritten = true;
  else summary.referenceError = refRes.error;
  const soulPath = path.join(profileDir, 'SOUL.md');
  try {
    const soul = fs.readFileSync(soulPath, 'utf8');
    // Apply both patches in sequence: DJ-tooling pointer first, then the
    // orchestrator addendum. Each is marker-idempotent, and the addendum
    // inserts before trailing HTML-comment metadata just like the pointer.
    const step1 = patchSoulWithDjToolingPointer(soul);
    const step2 = patchOrchestratorSoulWithAddendum(step1.content);
    if (step1.changed || step2.changed) {
      fs.writeFileSync(soulPath, step2.content);
      summary.soulPatched = true;
      summary.addendumPatched = step2.changed;
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      summary.soulError = err.message || String(err);
    }
  }
  return summary;
}

// Remove dj-tooling.md and any DJ-tooling SOUL pointer from profiles that
// aren't the orchestrator. Cleans up the fallout from the v1 backfill,
// which wrote both artifacts to every profile before we tightened scope.
// Idempotent: profiles that were never touched by v1 skip cleanly.
async function pruneStaleReferences({ hermesHome, profileNames }) {
  const results = [];
  for (const name of profileNames) {
    const profileDir = path.join(hermesHome, 'profiles', name);
    const summary = { profile: name, referenceRemoved: false, soulStripped: false };
    // 1. Remove dj-tooling.md if it's there.
    const refPath = path.join(profileDir, 'dj-tooling.md');
    try {
      fs.unlinkSync(refPath);
      summary.referenceRemoved = true;
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        summary.referenceError = err.message || String(err);
      }
    }
    // 2. Strip the SOUL pointer section if it's there.
    const soulPath = path.join(profileDir, 'SOUL.md');
    try {
      const soul = fs.readFileSync(soulPath, 'utf8');
      const strip = stripDjToolingPointer(soul);
      if (strip.changed) {
        fs.writeFileSync(soulPath, strip.content);
        summary.soulStripped = true;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        summary.soulError = err.message || String(err);
      }
    }
    results.push(summary);
  }
  return results;
}

module.exports = {
  slugify,
  createOrchestrator,
  writeFirstTasks,
  writeBedrockConfig,
  writeDjToolingReference,
  patchSoulWithDjToolingPointer,
  stripDjToolingPointer,
  soulHasDjToolingPointer,
  patchOrchestratorSoulWithAddendum,
  soulHasOrchestratorAddendum,
  refreshOrchestratorReferences,
  pruneStaleReferences,
  DJ_TOOLING_REFERENCE_PATH,
  DJ_TOOLING_POINTER_START,
  DJ_TOOLING_POINTER_END,
  ORCHESTRATOR_ADDENDUM_START,
  ORCHESTRATOR_ADDENDUM_END,
  ORCHESTRATOR_V2_MARKER,
  CONFIG_DEFAULTS_PATH,
};
