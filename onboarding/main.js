const { BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const child_process = require('node:child_process');
const os = require('node:os');
const hermesInstall = require('../hermesInstall');
const bedrockClient = require('../bedrockClient');
const wikipediaClient = require('../wikipediaClient');
const avatarInitials = require('../avatarInitials');
const profileWriter = require('../profileWriter');

const SOUL_TEMPLATE_PATH = path.join(__dirname, 'soul-template.md');
const FIRST_TASKS_TEMPLATE_PATH = path.join(__dirname, 'first-tasks-template.md');

function readTemplate(p) {
  return fs.readFileSync(p, 'utf8');
}

function firstRunNeeded(stateDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
    return s.firstRunComplete !== true;
  } catch {
    return true;
  }
}

function detectClaudeCodeToken() {
  try {
    const p = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    const t =
      (j.env && j.env.AWS_BEARER_TOKEN_BEDROCK) ||
      j.AWS_BEARER_TOKEN_BEDROCK ||
      null;
    if (t && typeof t === 'string' && t.trim().length > 0) {
      return { present: true, token: t.trim() };
    }
    return { present: false };
  } catch {
    return { present: false };
  }
}

function verifyHermesUnderScrubbedEnv({ slug, hermesHome, hermesBin }) {
  return new Promise((resolve) => {
    const env = {
      HOME: os.homedir(),
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin',
      HERMES_HOME: hermesHome,
    };
    let child;
    try {
      child = child_process.spawn(
        hermesBin,
        ['-p', slug, 'chat', '-q', 'reply only: works'],
        { env },
      );
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, error: 'timed out after 60s' });
    }, 60000);
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: (stderr || stdout).trim() || `exit ${code}` });
    });
  });
}

function runHermesSubprocess({ hermesBin, args, hermesHome }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = child_process.spawn(hermesBin, args, {
        env: { ...process.env, HERMES_HOME: hermesHome, HERMES_ACCEPT_HOOKS: '1' },
      });
    } catch (err) {
      resolve({ code: -1, stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function parseToolCountFromMcpTest(output) {
  const m = output.match(/(\d+)\s+tools?/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

function readLastLogLines(logFilePath, maxLines = 100) {
  try {
    const raw = fs.readFileSync(logFilePath, 'utf8');
    const lines = raw.split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines - 1)).join('\n');
  } catch {
    return '';
  }
}

function atlassianSubsetYamlBlock() {
  // Sara's 18-tool read-only starter set for Atlassian, per runbook §3b.
  const tools = [
    'atlassianUserInfo',
    'getAccessibleAtlassianResources',
    'getConfluenceSpaces',
    'getConfluencePage',
    'getPagesInConfluenceSpace',
    'getConfluencePageAncestors',
    'getConfluencePageDescendants',
    'getConfluencePageFooterComments',
    'getConfluencePageInlineComments',
    'searchConfluenceUsingCql',
    'getJiraIssue',
    'editJiraIssue',
    'getTransitionsForJiraIssue',
    'lookupJiraAccountId',
    'searchJiraIssuesUsingJql',
    'getVisibleJiraProjects',
    'getJiraProjectIssueTypesMetadata',
    'createJiraIssue',
  ];
  return (
    'mcp:\n' +
    '  atlassian:\n' +
    '    tools:\n' +
    '      include:\n' +
    tools.map((t) => `        - ${t}`).join('\n') +
    '\n'
  );
}

async function applyAtlassianSubset({ hermesHome, slug }) {
  const configPath = path.join(hermesHome, 'profiles', slug, 'config.yaml');
  let existing = '';
  try { existing = fs.readFileSync(configPath, 'utf8'); }
  catch (err) { return { ok: false, error: `could not read ${configPath}: ${err.message}` }; }
  // Naive concat — spec forbids `hermes config set` on list keys. If a mcp
  // block already exists we bail loudly rather than write a broken file.
  if (/^mcp:\s*$/m.test(existing) || /^mcp:\n/m.test(existing)) {
    return { ok: false, error: 'config.yaml already has an mcp: block — skipping subset write' };
  }
  const next = existing.trimEnd() + '\n' + atlassianSubsetYamlBlock();
  try {
    fs.writeFileSync(configPath, next);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function writeStateComplete(stateDir, slug) {
  const stateFile = path.join(stateDir, 'state.json');
  let existing = { profiles: {} };
  try { existing = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  existing.firstRunComplete = true;
  existing.orchestratorProfile = slug;
  if (!existing.profiles) existing.profiles = {};
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(existing, null, 2));
}

async function runOnboarding({ hermesHome, stateDir, hermesBin, logFilePath, onBeforeClose }) {
  const soulTemplate = readTemplate(SOUL_TEMPLATE_PATH);
  const firstTasksTemplate = readTemplate(FIRST_TASKS_TEMPLATE_PATH);

  const win = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 700,
    minHeight: 620,
    title: 'Welcome to Circe',
    resizable: true,
    closable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));

  const handlers = new Map();
  const on = (name, fn) => {
    ipcMain.handle(name, fn);
    handlers.set(name, fn);
  };

  const cleanup = () => {
    for (const name of handlers.keys()) {
      ipcMain.removeHandler(name);
    }
  };

  let finishState = { completed: false };

  on('onboarding:hermesDetect', async () => hermesInstall.detect());
  on('onboarding:hermesInstall', async () => {
    const send = (line) => {
      if (!win.isDestroyed()) {
        win.webContents.send('onboarding:hermesInstall:progress', line);
      }
    };
    return hermesInstall.install(send);
  });

  on('onboarding:bedrockDetectClaudeCode', async () => detectClaudeCodeToken());
  on('onboarding:bedrockVerifyDirect', async (_e, { apiKey }) =>
    bedrockClient.verify(apiKey),
  );

  on('onboarding:bedrockVerifyHermes', async (_e, { slug }) =>
    verifyHermesUnderScrubbedEnv({ slug, hermesHome, hermesBin }),
  );

  on('onboarding:pickCharacter', async (_e, { fandom, preferences, apiKey }) =>
    bedrockClient.pickCharacter({ fandom, preferences, apiKey, soulTemplate }),
  );

  function resolveProfileDir(slugOrDir) {
    if (!slugOrDir) return path.join(hermesHome, 'profiles', '_scratch');
    if (slugOrDir.includes('/') || slugOrDir.includes(path.sep)) return slugOrDir;
    return path.join(hermesHome, 'profiles', slugOrDir);
  }

  on('onboarding:fetchAvatar', async (_e, { characterName, profileDir }) => {
    const dir = resolveProfileDir(profileDir);
    const hit = await wikipediaClient.fetchLeadImage(characterName);
    if (!hit) return { source: 'miss' };
    const outPath = await wikipediaClient.saveAsAvatar(hit.imageBuffer, dir);
    return { source: 'wikipedia', path: outPath, sourceUrl: hit.sourceUrl };
  });

  on('onboarding:renderInitialsAvatar', async (_e, { characterName, profileDir }) => {
    const dir = resolveProfileDir(profileDir);
    const outPath = await avatarInitials.saveTo(characterName, dir);
    return { source: 'initials', path: outPath };
  });

  on('onboarding:uploadAvatar', async (_e, { profileDir }) => {
    const dir = resolveProfileDir(profileDir);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose an avatar image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const bytes = fs.readFileSync(res.filePaths[0]);
    fs.mkdirSync(dir, { recursive: true });
    const outPath = await wikipediaClient.saveAsAvatar(bytes, dir);
    return { ok: true, source: 'upload', path: outPath };
  });

  on('onboarding:deleteProfile', async (_e, { slug }) => {
    if (!slug) return { ok: false, error: 'no slug' };
    const del = await runHermesSubprocess({
      hermesBin,
      args: ['profile', 'delete', slug, '--yes'],
      hermesHome,
    });
    return { ok: del.code === 0, error: del.code === 0 ? undefined : (del.stderr || 'delete failed') };
  });

  on('onboarding:createOrchestrator', async (_e, args) => {
    const {
      slug,
      oneLiner,
      soulMd,
      avatarPath,
      avatarSource,
      apiKey,
    } = args;
    let avatarBytes;
    try {
      avatarBytes = fs.readFileSync(avatarPath);
    } catch (err) {
      return { ok: false, error: `Could not read avatar file: ${err.message}` };
    }
    const create = await profileWriter.createOrchestrator({
      slug,
      oneLiner,
      soulMd,
      avatarBytes,
      avatarSource,
      hermesHome,
      hermesBin,
    });
    if (!create.ok) return create;
    const cfg = await profileWriter.writeBedrockConfig({
      profileDir: create.profileDir,
      apiKey,
    });
    if (!cfg.ok) {
      // Rollback via a delete pass — mirrors profileWriter's own rollback.
      await runHermesSubprocess({
        hermesBin,
        args: ['profile', 'delete', slug, '--yes'],
        hermesHome,
      });
      return { ok: false, rolledBack: true, error: cfg.error };
    }
    return { ok: true, profileDir: create.profileDir };
  });

  on('onboarding:mcpTest', async (_e, { slug, serverName }) => {
    const r = await runHermesSubprocess({
      hermesBin,
      args: ['-p', slug, 'mcp', 'test', serverName],
      hermesHome,
    });
    if (r.code !== 0) {
      return { ok: false, error: (r.stderr || r.stdout).trim() };
    }
    const toolCount = parseToolCountFromMcpTest(r.stdout);
    return { ok: true, toolCount, output: r.stdout.trim() };
  });

  on('onboarding:mcpApplyAtlassianSubset', async (_e, { slug }) => {
    const applied = await applyAtlassianSubset({ hermesHome, slug });
    if (!applied.ok) return applied;
    const test = await runHermesSubprocess({
      hermesBin,
      args: ['-p', slug, 'mcp', 'test', 'atlassian'],
      hermesHome,
    });
    const toolCount = test.code === 0 ? parseToolCountFromMcpTest(test.stdout) : null;
    return { ok: test.code === 0, toolCount, output: (test.stdout || test.stderr).trim() };
  });

  on('onboarding:writeFirstTasks', async (_e, { slug }) => {
    const profileDir = path.join(hermesHome, 'profiles', slug);
    return profileWriter.writeFirstTasks(profileDir, firstTasksTemplate);
  });

  on('onboarding:copyToClipboard', async (_e, { text }) => {
    clipboard.writeText(text);
    return { ok: true };
  });

  on('onboarding:copyLastLogLines', async () => {
    const text = readLastLogLines(logFilePath || '');
    clipboard.writeText(text || '(no log content available)');
    return { ok: true };
  });

  return new Promise((resolve) => {
    on('onboarding:finish', async (_e, { slug }) => {
      try {
        writeStateComplete(stateDir, slug);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      finishState = { completed: true, orchestratorProfile: slug };
      // Spawn tiles before destroying the wizard so `window-all-closed`
      // never fires with zero windows and quits the app.
      if (typeof onBeforeClose === 'function') {
        try {
          await onBeforeClose(slug);
        } catch (err) {
          return { ok: false, error: err.message };
        }
      }
      setImmediate(() => {
        cleanup();
        if (!win.isDestroyed()) win.destroy();
        resolve(finishState);
      });
      return { ok: true };
    });

    win.on('closed', () => {
      cleanup();
      resolve(finishState);
    });
  });
}

module.exports = { runOnboarding, firstRunNeeded };
