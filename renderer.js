const profile = window.hermes.profile;

const md = (window.marked && window.marked.marked) || window.marked;
if (md && typeof md.setOptions === 'function') {
  md.setOptions({ gfm: true, breaks: true });
}

function renderMarkdown(text) {
  if (!md) return null;
  try {
    return md.parse(text || '');
  } catch {
    return null;
  }
}

function setMessageContent(el, role, text) {
  if (role === 'agent' && md) {
    const html = renderMarkdown(text);
    if (html != null) {
      el.innerHTML = html;
      return;
    }
  }
  el.textContent = text;
}

function formatAcpError(err) {
  const raw = err && (err.message || String(err));
  if (!raw) return 'ACP error';
  // If main.js wrapped a structured error, message is JSON.
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.message) {
      const parts = [parsed.message];
      const detail =
        (parsed.data && (parsed.data.detail || parsed.data.traceback)) || null;
      if (detail) parts.push(String(detail));
      if (parsed.code !== undefined) parts.push(`(code ${parsed.code})`);
      return parts.join('\n\n');
    }
  } catch {}
  return raw;
}

const transcript = document.getElementById('transcript');
const input = document.getElementById('input');
const form = document.getElementById('composer');
const sendBtn = document.getElementById('send');
const tabStrip = document.getElementById('tab-strip');
const newTabBtn = document.getElementById('new-tab');
const accessBtn = document.getElementById('access-btn');
const accessIcon = accessBtn ? accessBtn.querySelector('.access-icon') : null;

// ─── Access-mode gate ──────────────────────────────────────────────
// Three-state cycle: locked → ask → unlocked → locked. Icon + tooltip
// reflect current state; server-side enforcement lives in main.js /
// acpClient.js. This is the ONLY user-facing control for the gate.
const ACCESS_STATES = ['locked', 'ask', 'unlocked'];
const ACCESS_META = {
  locked:   { icon: '🔒', label: 'Locked — file changes auto-denied' },
  ask:      { icon: '⛔', label: 'Ask — choose per request' },
  unlocked: { icon: '🔓', label: 'Unlocked — file changes auto-allowed' },
};
let accessMode = 'unlocked'; // hydrated from main on boot

function paintAccessButton() {
  if (!accessBtn || !accessIcon) return;
  const meta = ACCESS_META[accessMode] || ACCESS_META.unlocked;
  accessIcon.textContent = meta.icon;
  accessBtn.title = `${meta.label} — click to cycle`;
  accessBtn.dataset.mode = accessMode;
}

async function cycleAccessMode() {
  const idx = ACCESS_STATES.indexOf(accessMode);
  const next = ACCESS_STATES[(idx + 1) % ACCESS_STATES.length];
  try {
    const res = await window.hermes.access.set(next);
    if (res && res.ok) {
      accessMode = res.mode;
      paintAccessButton();
      // If we just moved AWAY from 'ask' and there were open cards, cancel them.
      if (accessMode !== 'ask') resolveAllPendingPermissionCards(null);
    }
  } catch (err) {
    console.error('failed to set access mode', err);
  }
}

if (accessBtn) accessBtn.addEventListener('click', cycleAccessMode);

document.getElementById('profile-name').textContent = profile.display;
document.getElementById('profile-model').textContent = profile.model;
document.title = `hermes · ${profile.display}`;
document.body.dataset.profile = profile.name;

const avatarEl = document.getElementById('avatar');
avatarEl.setAttribute('role', 'button');
avatarEl.setAttribute('tabindex', '0');
avatarEl.setAttribute('title', 'Click to change avatar');
avatarEl.style.cursor = 'pointer';

function setInitialAvatar() {
  avatarEl.innerHTML = '';
  avatarEl.textContent = (profile.display || '?').charAt(0).toUpperCase();
  avatarEl.classList.add('avatar-fallback');
}

function renderAvatar(dataUrl) {
  if (!dataUrl) {
    setInitialAvatar();
    return;
  }
  avatarEl.innerHTML = '';
  avatarEl.classList.remove('avatar-fallback');
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  img.addEventListener('error', setInitialAvatar);
  avatarEl.append(img);
}

window.hermes.getAvatar().then(renderAvatar);

async function pickAvatar() {
  try {
    const r = await window.hermes.pickAvatar();
    if (r && r.ok) renderAvatar(r.dataUrl);
    else if (r && r.error) console.error('avatar pick failed:', r.error);
  } catch (err) {
    console.error('avatar pick threw:', err);
  }
}

avatarEl.addEventListener('click', pickAvatar);
avatarEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pickAvatar();
  }
});

const tabs = [];
const tabsById = new Map();
let activeTabId = null;
let tabCounter = 0;

function updateComposer() {
  const tab = tabsById.get(activeTabId);
  if (!tab) {
    input.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stop');
    input.placeholder = 'Starting session…';
    return;
  }
  input.disabled = tab.busy;
  if (tab.busy) {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Stop';
    sendBtn.classList.add('stop');
    sendBtn.title = 'Stop this agent';
    input.placeholder = `${profile.display} is thinking…`;
  } else {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    sendBtn.classList.remove('stop');
    sendBtn.title = '';
    input.placeholder = `Message ${profile.display}…`;
  }
}

function firstUserPreview(tab) {
  if (!tab.firstUserText) return null;
  const trimmed = tab.firstUserText.trim();
  if (!trimmed) return null;
  return trimmed.length > 22 ? trimmed.slice(0, 22) + '…' : trimmed;
}

function renderTabs() {
  tabStrip.innerHTML = '';
  for (const tab of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    if (tab.id === activeTabId) btn.classList.add('active');
    if (tab.waiting && tab.id !== activeTabId) btn.classList.add('waiting');
    if (tab.busy) btn.classList.add('busy');

    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = firstUserPreview(tab) || tab.defaultLabel;
    btn.append(label);

    if (tab.waiting && tab.id !== activeTabId) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      btn.append(dot);
    }

    if (tabs.length > 1) {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Close workstream';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });
      btn.append(close);
    }

    btn.addEventListener('click', () => activateTab(tab.id));
    tabStrip.append(btn);
  }
}

// Bumped every time the transcript DOM is wiped (renderTranscript). Queued
// scroll snapshots capture this at schedule time and bail if it has moved on
// — prevents a late setTimeout/RAF/img-load/font-ready callback from an
// earlier tab's render from clobbering the current tab's scroll position.
let transcriptGen = 0;

// Scroll to bottom, but wait for layout to settle. `renderTranscript`
// runs synchronously while markdown/images/fonts are still resolving, so
// a single `scrollTop = scrollHeight` snapshots a stale (too-small)
// scrollHeight and lands us in the middle of the transcript on restore.
// We schedule two follow-up scrolls (next frame, and 120ms later) to
// catch the most common late-layout cases, and also re-anchor if any
// <img> inside the transcript finishes loading afterwards.
//
// Every deferred snap is gated on `transcriptGen` so that when the user
// switches tabs (or boot activates a different tab than the one whose
// scroll was queued), stale callbacks no-op instead of scrolling the
// wrong DOM.
function scrollTranscriptToBottom() {
  const gen = transcriptGen;
  const snap = () => {
    if (gen !== transcriptGen) return;
    transcript.scrollTop = transcript.scrollHeight;
  };
  snap();
  requestAnimationFrame(() => {
    snap();
    // Second settle: covers marked-rendered content, web fonts, avatar
    // images that inflate height after the initial paint.
    setTimeout(snap, 120);
  });
  // Any image that loads later (e.g. inline markdown image) grows the
  // scrollHeight — re-anchor to bottom on each load. Guarded by `gen`
  // so an image finishing after a tab switch doesn't scroll the new tab.
  for (const img of transcript.querySelectorAll('img')) {
    if (!img.complete) {
      img.addEventListener('load', snap, { once: true });
      img.addEventListener('error', snap, { once: true });
    }
  }
}

// On macOS lid-close → lid-open, the renderer is suspended and layout
// re-computes on wake. Chromium's scroll anchoring can lock onto a
// mid-transcript element and leave us parked there. Re-anchor to bottom
// whenever the tile becomes visible again. Uses the hardened
// scrollTranscriptToBottom() path (RAF + 120ms + img re-anchor + gen guard).
function reanchorOnWake() {
  if (document.hidden) return;
  if (!tabsById.get(activeTabId)) return;
  scrollTranscriptToBottom();
}
document.addEventListener('visibilitychange', reanchorOnWake);
window.addEventListener('pageshow', reanchorOnWake);

function renderTranscript() {
  transcriptGen += 1;
  transcript.innerHTML = '';
  const tab = tabsById.get(activeTabId);
  if (!tab) return;
  for (const m of tab.messages) {
    const el = document.createElement('div');
    el.className = `msg ${m.role} ${m.cls || ''}`.trim();
    if (m.cls === 'error' || m.role !== 'agent') el.textContent = m.text;
    else setMessageContent(el, m.role, m.text);
    transcript.append(el);
  }
  scrollTranscriptToBottom();
}

function appendMessage(tab, role, text, cls = '') {
  tab.messages.push({ role, text, cls });
  if (tab.id === activeTabId) {
    const el = document.createElement('div');
    el.className = `msg ${role} ${cls}`.trim();
    if (cls === 'error' || role !== 'agent') el.textContent = text;
    else setMessageContent(el, role, text);
    transcript.append(el);
    transcript.scrollTop = transcript.scrollHeight;
    return el;
  }
  return null;
}

function activateTab(id) {
  if (activeTabId === id) return;
  activeTabId = id;
  const tab = tabsById.get(id);
  if (tab) tab.waiting = false;
  renderTabs();
  renderTranscript();
  updateComposer();
  if (!input.disabled) input.focus();
}

async function createTab({
  activate = true,
  restored = null,
} = {}) {
  tabCounter += 1;
  const localId = `t${tabCounter}`;
  const tab = {
    id: localId,
    sessionId: null,
    defaultLabel: restored
      ? restored.defaultLabel || `Tab ${tabCounter}`
      : `Tab ${tabCounter}`,
    messages: restored && Array.isArray(restored.messages) ? [...restored.messages] : [],
    busy: false,
    waiting: false,
    firstUserText: restored ? restored.firstUserText || null : null,
    pendingBubble: null,
    pendingBubbleEl: null,
    agentText: '',
    toolBubbleEl: null,
    toolBubble: null,
    starting: true,
    replaying: false,
  };
  tabs.push(tab);
  tabsById.set(localId, tab);
  if (activate) activateTab(localId);
  else renderTabs();

  const priorSessionId = restored && restored.sessionId ? restored.sessionId : null;

  try {
    if (priorSessionId) {
      tab.sessionId = priorSessionId;
      tab.replaying = true;
      const res = await window.hermes.loadSession(priorSessionId);
      tab.replaying = false;
      if (!res || !res.ok) {
        const { sessionId } = await window.hermes.newSession();
        tab.sessionId = sessionId;
      }
    } else {
      const { sessionId } = await window.hermes.newSession();
      tab.sessionId = sessionId;
    }
    tab.starting = false;
    if (tab.id === activeTabId) updateComposer();
  } catch (err) {
    tab.replaying = false;
    tab.starting = false;
    appendMessage(tab, 'agent', formatAcpError(err), 'error');
  }
  persistState();
  return tab;
}

let persistTimer = null;
function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload = {
      activeIndex: Math.max(0, tabs.findIndex((t) => t.id === activeTabId)),
      tabs: tabs.map((t) => ({
        sessionId: t.sessionId,
        defaultLabel: t.defaultLabel,
        firstUserText: t.firstUserText,
        messages: t.messages
          .filter((m) => m.role !== 'tool' && m.role !== 'permission' && m.cls !== 'retry')
          .map((m) => ({ role: m.role, text: m.text, cls: m.cls || '' })),
      })),
    };
    window.hermes.saveState(payload).catch(() => {});
  }, 250);
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.sessionId) window.hermes.cancel(tab.sessionId).catch(() => {});
  tabs.splice(idx, 1);
  tabsById.delete(id);
  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1] || tabs[0];
    activeTabId = next ? next.id : null;
  }
  renderTabs();
  renderTranscript();
  updateComposer();
  persistState();
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).join('');
  if (content.text) return content.text;
  if (content.type === 'text' && content.text) return content.text;
  return '';
}

function tabForSession(sessionId) {
  if (!sessionId) return null;
  for (const t of tabs) if (t.sessionId === sessionId) return t;
  return null;
}

window.hermes.onUpdate((params) => {
  const u = params && params.update;
  if (!u) return;
  const tab = tabForSession(params.sessionId);
  if (!tab) return;
  if (tab.replaying) return;

  const kind = u.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    const piece = extractText(u.content);
    if (!piece) return;
    if (!tab.pendingBubble) {
      tab.pendingBubble = { role: 'agent', text: '', cls: '' };
      tab.messages.push(tab.pendingBubble);
      tab.agentText = '';
      if (tab.id === activeTabId) {
        const el = document.createElement('div');
        el.className = 'msg agent';
        el.textContent = '';
        transcript.append(el);
        tab.pendingBubbleEl = el;
      }
    }
    tab.agentText += piece;
    tab.pendingBubble.text = tab.agentText;
    if (tab.id === activeTabId && tab.pendingBubbleEl) {
      setMessageContent(tab.pendingBubbleEl, 'agent', tab.agentText);
      transcript.scrollTop = transcript.scrollHeight;
    }
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const name = u.title || u.toolCallId || '';
    if (!name) return;
    const label = `⚙ ${name}`;
    if (!tab.toolBubble) {
      tab.toolBubble = { role: 'tool', text: label, cls: '' };
      tab.messages.push(tab.toolBubble);
      if (tab.id === activeTabId) {
        const el = document.createElement('div');
        el.className = 'msg tool';
        el.textContent = label;
        transcript.append(el);
        tab.toolBubbleEl = el;
      }
    } else {
      tab.toolBubble.text = label;
      if (tab.id === activeTabId && tab.toolBubbleEl) {
        tab.toolBubbleEl.textContent = label;
      }
    }
  }
});

window.hermes.onError(({ message }) => {
  const tab = tabsById.get(activeTabId) || tabs[0];
  if (tab) appendMessage(tab, 'agent', message || 'ACP error', 'error');
});

if (window.hermes.onRetryStatus) {
  window.hermes.onRetryStatus((params) => {
    const tab = activeTab();
    if (!tab) return;
    // Transient status: append but flag as 'retry' so persistState skips it.
    const text = `Retrying session start… (attempt ${params.attempt}/${params.max})`;
    appendMessage(tab, 'agent', text, 'retry');
  });
}

window.hermes.onExit(({ code }) => {
  for (const tab of tabs) {
    appendMessage(tab, 'agent', `agent exited (${code})`, 'error');
    tab.busy = false;
  }
  updateComposer();
  persistState();
});

// ─── Permission-request cards ──────────────────────────────────────
// Rendered inline in the transcript when access mode is 'ask' (and
// also as an informational note when 'locked' auto-denies something).
// Cards are ephemeral — we don't persist them across restarts because
// the underlying RPC is already invalidated when hermes exits.

const pendingCards = new Map(); // requestKey → { el, tabId }

function toolCallSummary(toolCall) {
  if (!toolCall) return 'a tool call';
  const kind = toolCall.kind || toolCall.type || '';
  const title = toolCall.title || toolCall.name || toolCall.toolCallId || 'tool';
  return kind ? `${title} (${kind})` : title;
}

function buildPermissionCard({ requestKey, resolved, toolCall, options }, tab) {
  const el = document.createElement('div');
  el.className = 'msg permission';
  if (resolved === 'locked') el.classList.add('resolved-locked');

  const head = document.createElement('div');
  head.className = 'permission-head';
  head.textContent = resolved === 'locked'
    ? `🔒 denied: ${toolCallSummary(toolCall)}`
    : `⛔ approve: ${toolCallSummary(toolCall)}?`;
  el.append(head);

  if (resolved !== 'locked' && requestKey) {
    const row = document.createElement('div');
    row.className = 'permission-actions';
    const opts = Array.isArray(options) ? options : [];
    if (!opts.length) {
      // Synthesize a minimal allow/deny pair if the agent didn't send any.
      opts.push({ optionId: 'allow', name: 'Allow', kind: 'allow_once' });
      opts.push({ optionId: 'reject', name: 'Deny', kind: 'reject_once' });
    }
    for (const opt of opts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'permission-btn';
      const kind = (opt.kind || '').toLowerCase();
      if (kind.startsWith('reject') || /reject|deny|no|cancel/i.test(opt.name || opt.optionId || '')) {
        btn.classList.add('deny');
      } else {
        btn.classList.add('allow');
      }
      btn.textContent = opt.name || opt.optionId || 'ok';
      btn.addEventListener('click', async () => {
        // Disable everything in this card so double-click doesn't double-fire.
        for (const b of row.querySelectorAll('button')) b.disabled = true;
        try {
          await window.hermes.access.respond(requestKey, opt.optionId || opt.name);
        } catch (err) {
          console.error('permission respond failed', err);
        }
        markCardResolved(requestKey, opt.name || opt.optionId);
      });
      row.append(btn);
    }
    el.append(row);
  }

  return el;
}

function markCardResolved(requestKey, label) {
  const rec = pendingCards.get(requestKey);
  if (!rec) return;
  const { el } = rec;
  el.classList.add('resolved');
  const head = el.querySelector('.permission-head');
  if (head) head.textContent = `✓ ${label || 'resolved'}`;
  const row = el.querySelector('.permission-actions');
  if (row) row.remove();
  pendingCards.delete(requestKey);
}

function resolveAllPendingPermissionCards(optionId) {
  // Fire-and-forget respond() for each; leave the cards visible but marked.
  for (const [key] of pendingCards) {
    window.hermes.access.respond(key, optionId).catch(() => {});
    markCardResolved(key, optionId ? optionId : 'cancelled');
  }
}

window.hermes.access.onRequest((payload) => {
  if (!payload) return;
  // Which tab does this belong to? Prefer the active tab (there's usually
  // only one prompt in flight per tile). Fall back to first tab.
  const tab = tabsById.get(activeTabId) || tabs[0];
  if (!tab) return;
  const card = buildPermissionCard(payload, tab);
  tab.messages.push({
    role: 'permission',
    text: '',
    cls: payload.resolved === 'locked' ? 'resolved-locked' : '',
  });
  if (tab.id === activeTabId) {
    transcript.append(card);
    transcript.scrollTop = transcript.scrollHeight;
  }
  if (payload.requestKey && payload.resolved !== 'locked') {
    pendingCards.set(payload.requestKey, { el: card, tabId: tab.id });
  }
});

window.addEventListener('beforeunload', () => {
  const payload = {
    activeIndex: Math.max(0, tabs.findIndex((t) => t.id === activeTabId)),
    tabs: tabs.map((t) => ({
      defaultLabel: t.defaultLabel,
      firstUserText: t.firstUserText,
      messages: t.messages
        .filter((m) => m.role !== 'tool' && m.role !== 'permission')
        .map((m) => ({ role: m.role, text: m.text, cls: m.cls || '' })),
    })),
  };
  window.hermes.saveState(payload);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tab = tabsById.get(activeTabId);
  if (!tab) return;

  if (tab.busy) {
    if (!tab.sessionId) return;
    tab.cancelling = true;
    sendBtn.disabled = true;
    try {
      await window.hermes.cancel(tab.sessionId);
    } catch {}
    tab.busy = false;
    tab.cancelling = false;
    appendMessage(tab, 'agent', '⏹ stopped', 'error');
    tab.pendingBubble = null;
    tab.pendingBubbleEl = null;
    tab.toolBubble = null;
    tab.toolBubbleEl = null;
    if (tab.id !== activeTabId) tab.waiting = true;
    renderTabs();
    updateComposer();
    if (tab.id === activeTabId) input.focus();
    persistState();
    return;
  }

  const text = input.value.trim();
  if (!text || !tab.sessionId) return;

  input.value = '';
  tab.busy = true;
  if (!tab.firstUserText) tab.firstUserText = text;
  appendMessage(tab, 'user', text);
  tab.pendingBubble = null;
  tab.pendingBubbleEl = null;
  tab.agentText = '';
  tab.toolBubble = null;
  tab.toolBubbleEl = null;
  renderTabs();
  updateComposer();

  try {
    await window.hermes.prompt(tab.sessionId, text);
  } catch (err) {
    if (!tab.cancelling) {
      appendMessage(tab, 'agent', formatAcpError(err), 'error');
    }
  } finally {
    if (!tab.cancelling) {
      tab.busy = false;
      tab.pendingBubble = null;
      tab.pendingBubbleEl = null;
      tab.toolBubble = null;
      tab.toolBubbleEl = null;
      if (tab.id !== activeTabId) tab.waiting = true;
      renderTabs();
      updateComposer();
      if (tab.id === activeTabId) input.focus();
      persistState();
    }
  }
});

newTabBtn.addEventListener('click', () => createTab({ activate: true }));

(async function boot() {
  // Hydrate access mode from main before anything else so the button paints correctly.
  try {
    const res = await window.hermes.access.get();
    if (res && res.mode) accessMode = res.mode;
  } catch {}
  paintAccessButton();

  let saved = null;
  try {
    saved = await window.hermes.loadState();
  } catch {}
  const restoredTabs = saved && Array.isArray(saved.tabs) ? saved.tabs : [];
  if (restoredTabs.length) {
    for (let i = 0; i < restoredTabs.length; i++) {
      await createTab({ activate: i === (saved.activeIndex || 0), restored: restoredTabs[i] });
    }
    if (tabs.length && !tabsById.get(activeTabId)) activateTab(tabs[0].id);
  } else {
    await createTab({ activate: true });
  }
  updateComposer();
  // Final safety net: after all restore async work has flushed, force one
  // more scroll-to-bottom once fonts are ready. Fonts loading late is a
  // common cause of the "restored session parked mid-transcript" bug.
  scrollTranscriptToBottom();
  if (document.fonts && typeof document.fonts.ready?.then === 'function') {
    document.fonts.ready.then(scrollTranscriptToBottom).catch(() => {});
  }
})();
