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

// --- Step-runner dispatch -------------------------------------------------

const _origGoTo = goToStep;
window.goToStep = function (n) {
  _origGoTo(n);
  if (n === 2) runStep2();
  if (n === 3) runStep3();
};
