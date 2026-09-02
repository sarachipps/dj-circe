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

async function writeBedrockConfig({ profileDir, apiKey }) {
  // Register the same platform toolsets Circe's hand-tuned profiles use.
  // Without these, Claude has no local scaffolding (no memory/todo/skills/
  // terminal), which shows up as very slow turns because everything has to
  // be reasoned from scratch.
  const yaml =
    'platform_toolsets:\n' +
    '  cli:\n' +
    '    - clarify\n' +
    '    - code_execution\n' +
    '    - cronjob\n' +
    '    - file\n' +
    '    - kanban\n' +
    '    - memory\n' +
    '    - session_search\n' +
    '    - skills\n' +
    '    - terminal\n' +
    '    - todo\n' +
    '    - web\n' +
    'model:\n' +
    '  default: anthropic.claude-sonnet-5\n' +
    '  provider: dj-bedrock\n' +
    'providers:\n' +
    '  dj-bedrock:\n' +
    '    base_url: https://bedrock-mantle.us-east-1.api.aws/anthropic\n' +
    '    key_env: ANTHROPIC_API_KEY\n' +
    '    api_mode: anthropic_messages\n';
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'config.yaml'), yaml);
    fs.writeFileSync(path.join(profileDir, '.env'), `ANTHROPIC_API_KEY=${apiKey}\n`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

module.exports = {
  slugify,
  createOrchestrator,
  writeFirstTasks,
  writeBedrockConfig,
  writeDjToolingReference,
  DJ_TOOLING_REFERENCE_PATH,
};
