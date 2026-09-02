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

// Refresh the DJ-tooling reference and SOUL pointer in every named profile
// directory under hermesHome/profiles/. Idempotent by design: rewrites
// dj-tooling.md unconditionally (source of truth is in-repo), and inserts
// the SOUL pointer section only if a matching marker isn't already present.
// Returns a per-profile summary for logging.
async function refreshReferencesForAllProfiles({ hermesHome, profileNames, sourcePath }) {
  const results = [];
  for (const name of profileNames) {
    const profileDir = path.join(hermesHome, 'profiles', name);
    const summary = { profile: name, referenceWritten: false, soulPatched: false };
    // 1. Refresh dj-tooling.md.
    const refRes = await writeDjToolingReference({ profileDir, sourcePath });
    if (refRes.ok) {
      summary.referenceWritten = true;
    } else {
      summary.referenceError = refRes.error;
    }
    // 2. Patch SOUL.md if the pointer section isn't there yet.
    const soulPath = path.join(profileDir, 'SOUL.md');
    try {
      const soul = fs.readFileSync(soulPath, 'utf8');
      const patch = patchSoulWithDjToolingPointer(soul);
      if (patch.changed) {
        fs.writeFileSync(soulPath, patch.content);
        summary.soulPatched = true;
      }
    } catch (err) {
      // No SOUL.md is fine — the profile might be a scratch or partial one.
      // We only record real errors that aren't ENOENT.
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
  soulHasDjToolingPointer,
  refreshReferencesForAllProfiles,
  DJ_TOOLING_REFERENCE_PATH,
  DJ_TOOLING_POINTER_START,
  DJ_TOOLING_POINTER_END,
  CONFIG_DEFAULTS_PATH,
};
