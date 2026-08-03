// Wizard renderer. Step-navigation + shared helpers only in this task;
// per-step handlers land in later tasks.

const state = {
  step: 1,
  bedrockToken: null,
  bedrockCase: null,
  fandom: '',
  preferences: '',
  character: null,
  avatarPath: null,
  avatarSource: null,
  slug: null,
  profileDir: null,
  mcpChoice: 'orchestrator',
};

const stepEl = (n) => document.querySelector(`.step[data-step="${n}"]`);
const totalSteps = 6;

function goToStep(n) {
  state.step = n;
  for (let i = 1; i <= totalSteps; i++) {
    const el = stepEl(i);
    if (el) el.hidden = i !== n;
  }
  const indicator = document.getElementById('step-indicator');
  if (indicator) indicator.textContent = `Step ${n} of ${totalSteps}`;
  const back = document.getElementById('back-btn');
  if (back) back.disabled = n === 1;
}

function showError(container, msg) {
  container.textContent = msg;
  container.hidden = false;
  container.classList.add('error');
}
function hideError(container) {
  container.textContent = '';
  container.hidden = true;
  container.classList.remove('error');
}

function bindGlobalChrome() {
  document.getElementById('back-btn').addEventListener('click', () => {
    if (state.step > 1) window.goToStep(state.step - 1);
  });
  document.querySelectorAll('[data-action="next"]').forEach((btn) => {
    btn.addEventListener('click', () => window.goToStep(state.step + 1));
  });
}

// Expose helpers to per-step scripts loaded in later tasks. Everything is
// in one file for now; we can split if it grows unwieldy.
window.__wizard = { state, goToStep, showError, hideError };

document.addEventListener('DOMContentLoaded', () => {
  bindGlobalChrome();
  goToStep(1);
});

// --- Step 2: Hermes check ------------------------------------------------

async function runStep2() {
  const container = document.getElementById('hermes-state');
  const logBox = document.getElementById('hermes-install-log');
  const installBtn = document.getElementById('hermes-install');
  const retryBtn = document.getElementById('hermes-retry');
  const quitBtn = document.getElementById('hermes-quit');
  const copyLogBtn = document.getElementById('hermes-copy-log');
  for (const b of [installBtn, retryBtn, quitBtn, copyLogBtn]) b.hidden = true;
  logBox.hidden = true;
  container.textContent = 'Checking…';
  container.className = 'state';

  const r = await window.onboarding.hermesDetect();
  if (r.present) {
    container.textContent = `Hermes is installed. (${r.version || 'version unknown'})`;
    container.classList.add('ok');
    setTimeout(() => window.goToStep(3), 800);
    return;
  }
  container.textContent =
    'Circe needs Hermes to run agents. I can install it for you now (~30 seconds).';
  installBtn.hidden = false;
  installBtn.onclick = async () => {
    installBtn.disabled = true;
    logBox.hidden = false;
    logBox.textContent = '';
    const res = await window.onboarding.hermesInstall((line) => {
      logBox.textContent += line + '\n';
      logBox.scrollTop = logBox.scrollHeight;
    });
    installBtn.disabled = false;
    if (res.ok) {
      // Re-detect after install.
      const d = await window.onboarding.hermesDetect();
      if (d.present) {
        container.textContent = `Hermes installed (${d.version || ''}). Continuing…`;
        container.classList.add('ok');
        setTimeout(() => window.goToStep(3), 800);
        return;
      }
      container.textContent = 'Restart Circe to pick up the new install.';
      container.classList.add('error');
      quitBtn.hidden = false;
      quitBtn.onclick = () => window.close();
      return;
    }
    container.textContent = res.error || 'Install failed.';
    container.classList.add('error');
    retryBtn.hidden = false;
    copyLogBtn.hidden = false;
    retryBtn.onclick = () => runStep2();
    copyLogBtn.onclick = () => window.onboarding.copyLastLogLines();
  };
}

// --- Step 3: Bedrock credentials -----------------------------------------

async function runStep3() {
  const caseA = document.getElementById('bedrock-case-a');
  const caseB = document.getElementById('bedrock-case-b');
  const reuseBtn = document.getElementById('bedrock-reuse');
  const pasteBtn = document.getElementById('bedrock-paste-continue');
  const input = document.getElementById('bedrock-token-input');
  const verifyState = document.getElementById('bedrock-verify-state');
  const errActions = document.getElementById('bedrock-error-actions');
  const copyLogBtn = document.getElementById('bedrock-copy-log');
  const helpLink = document.getElementById('bedrock-help-link');

  caseA.hidden = true;
  caseB.hidden = true;
  verifyState.hidden = true;
  errActions.hidden = true;
  input.value = '';

  helpLink.onclick = (e) => {
    e.preventDefault();
    window.onboarding.openExternal(helpLink.dataset.url);
  };

  const detect = await window.onboarding.bedrockDetectClaudeCode();
  if (detect.present) {
    caseA.hidden = false;
    reuseBtn.onclick = () => verifyAndAdvance(detect.token, 'A');
  } else {
    caseB.hidden = false;
    pasteBtn.onclick = () => {
      const tok = input.value.trim();
      if (!tok) {
        showError(verifyState, 'Paste a Bedrock API key or use the walkthrough link.');
        return;
      }
      verifyAndAdvance(tok, 'B');
    };
  }

  copyLogBtn.onclick = () => window.onboarding.copyLastLogLines();

  async function verifyAndAdvance(token, kind) {
    verifyState.hidden = false;
    verifyState.className = 'state';
    verifyState.textContent = 'Verifying with Bedrock…';
    errActions.hidden = true;
    const r = await window.onboarding.bedrockVerifyDirect(token);
    if (r.ok) {
      state.bedrockToken = token;
      state.bedrockCase = kind;
      verifyState.textContent = 'Bedrock says: works. ✓';
      verifyState.classList.add('ok');
      setTimeout(() => window.goToStep(4), 700);
      return;
    }
    showError(verifyState, r.error);
    errActions.hidden = false;
  }
}

function slugifyRenderer(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// --- Step 4: Fandom -----------------------------------------------------

async function runStep4() {
  const submit = document.getElementById('fandom-submit');
  const loading = document.getElementById('fandom-loading');
  const errBox = document.getElementById('fandom-error');
  const fandomIn = document.getElementById('fandom-input');
  const prefsIn = document.getElementById('preferences-input');
  loading.hidden = true;
  errBox.hidden = true;
  submit.disabled = false;
  submit.onclick = async () => {
    const fandom = fandomIn.value.trim();
    if (!fandom) {
      showError(errBox, 'Tell me a fandom you love, first.');
      return;
    }
    hideError(errBox);
    submit.disabled = true;
    loading.hidden = false;
    state.fandom = fandom;
    state.preferences = prefsIn.value.trim();
    const r = await window.onboarding.pickCharacter({
      fandom,
      preferences: state.preferences,
      apiKey: state.bedrockToken,
    });
    loading.hidden = true;
    submit.disabled = false;
    if (r.error) {
      showError(errBox, r.error);
      return;
    }
    state.character = r;
    state.slug = slugifyRenderer(r.name);
    window.goToStep(5);
  };
}

// --- Step 5: Meet your Orchestrator -------------------------------------

let _pendingAvatarPath = null;
let _pendingAvatarSource = null;

async function runStep5() {
  const header = document.getElementById('orchestrator-header');
  const oneLiner = document.getElementById('orchestrator-oneliner');
  const soulPreview = document.getElementById('soul-preview');
  const avatarEl = document.getElementById('orchestrator-avatar');
  const tryAnother = document.getElementById('try-another');
  const confirm = document.getElementById('confirm-orchestrator');
  const uploadBtn = document.getElementById('upload-avatar');
  const regenBtn = document.getElementById('regen-avatar');
  const errBox = document.getElementById('meet-error');
  const logActions = document.getElementById('meet-log-actions');
  const copyLogBtn = document.getElementById('meet-copy-log');

  const c = state.character;
  header.textContent = `Meet ${c.name}`;
  oneLiner.textContent = c.oneLiner;
  soulPreview.value = c.soulMd;

  // Where does the avatar go? We use a scratch dir until profile-create
  // succeeds; on success we already have the profile dir.
  const scratchDir = `${await getTmpProfileDir(state.slug)}`;
  await loadAvatar(scratchDir);

  hideError(errBox);
  logActions.hidden = true;
  confirm.disabled = false;

  tryAnother.onclick = async () => {
    // Loops back to Step 4 (which keeps its inputs).
    window.goToStep(4);
  };
  uploadBtn.onclick = async () => {
    const res = await window.onboarding.uploadAvatar({ profileDir: scratchDir });
    if (res.canceled) return;
    if (!res.ok) {
      showError(errBox, res.error || 'Upload failed.');
      return;
    }
    _pendingAvatarPath = res.path;
    _pendingAvatarSource = null; // user upload — no wiki URL
    avatarEl.src = `file://${res.path}?t=${Date.now()}`;
  };
  regenBtn.onclick = async () => {
    await loadAvatar(scratchDir, { forceInitials: false });
  };

  confirm.onclick = async () => {
    confirm.disabled = true;
    const soulMdEdited = soulPreview.value;
    const create = await window.onboarding.createOrchestrator({
      slug: state.slug,
      oneLiner: c.oneLiner,
      soulMd: soulMdEdited,
      avatarPath: _pendingAvatarPath,
      avatarSource: _pendingAvatarSource,
      apiKey: state.bedrockToken,
    });
    if (!create.ok) {
      confirm.disabled = false;
      const msg = create.rolledBack
        ? `Something went wrong writing the profile, so I rolled it back. ${create.error}`
        : create.error;
      showError(errBox, msg);
      logActions.hidden = false;
      copyLogBtn.onclick = () => window.onboarding.copyLastLogLines();
      return;
    }
    state.profileDir = create.profileDir;
    state.avatarPath = _pendingAvatarPath;
    state.avatarSource = _pendingAvatarSource;
    // Hermes-side re-verify to catch env-shadowed configs.
    const v = await window.onboarding.bedrockVerifyHermes(state.slug);
    if (!v.ok) {
      confirm.disabled = false;
      showError(
        errBox,
        `Hermes couldn't reach Bedrock with the profile we just wrote (${v.error}). Rolling back — you'll be sent back to the Bedrock step.`,
      );
      logActions.hidden = false;
      copyLogBtn.onclick = () => window.onboarding.copyLastLogLines();
      // Bounce back to Step 3 after a short delay.
      setTimeout(() => window.goToStep(3), 2500);
      return;
    }
    window.goToStep(6);
  };

  async function loadAvatar(profileDir, opts = {}) {
    _pendingAvatarPath = null;
    _pendingAvatarSource = null;
    avatarEl.removeAttribute('src');
    if (!opts.forceInitials) {
      const wiki = await window.onboarding.fetchAvatar({
        characterName: c.name,
        profileDir,
      });
      if (wiki.source === 'wikipedia') {
        _pendingAvatarPath = wiki.path;
        _pendingAvatarSource = wiki.sourceUrl;
        avatarEl.src = `file://${wiki.path}?t=${Date.now()}`;
        return;
      }
    }
    const init = await window.onboarding.renderInitialsAvatar({
      characterName: c.name,
      profileDir,
    });
    _pendingAvatarPath = init.path;
    _pendingAvatarSource = null;
    avatarEl.src = `file://${init.path}?t=${Date.now()}`;
  }
}

async function getTmpProfileDir(slug) {
  // Main-side handlers resolve to <HERMES_HOME>/profiles/<slug>. Before the
  // profile is created (via createOrchestrator), scratch files land in a
  // sibling '_scratch' dir under HERMES_HOME/profiles/. After, files land
  // in the real profile dir with the same slug.
  return slug || '_scratch';
}

// --- Step-runner dispatch -------------------------------------------------

const _origGoTo = goToStep;
window.goToStep = function (n) {
  _origGoTo(n);
  if (n === 2) runStep2();
  if (n === 3) runStep3();
  if (n === 4) runStep4();
  if (n === 5) runStep5();
};
