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
    if (state.step > 1) goToStep(state.step - 1);
  });
  document.querySelectorAll('[data-action="next"]').forEach((btn) => {
    btn.addEventListener('click', () => goToStep(state.step + 1));
  });
}

// Expose helpers to per-step scripts loaded in later tasks. Everything is
// in one file for now; we can split if it grows unwieldy.
window.__wizard = { state, goToStep, showError, hideError };

document.addEventListener('DOMContentLoaded', () => {
  bindGlobalChrome();
  goToStep(1);
});
