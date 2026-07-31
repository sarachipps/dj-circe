const { contextBridge, ipcRenderer } = require('electron');
const log = require('electron-log/renderer');

Object.assign(console, log.functions);
window.addEventListener('error', (e) => {
  log.error('renderer error:', e.message, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  log.error('renderer unhandledRejection:', e.reason);
});

function argValue(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

contextBridge.exposeInMainWorld('hermes', {
  profile: {
    name: argValue('--profile-name='),
    display: argValue('--profile-display=') || argValue('--profile-name='),
    model: argValue('--profile-model='),
  },
  getAvatar: () => ipcRenderer.invoke('avatar:get'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  newSession: () => ipcRenderer.invoke('acp:newSession'),
  loadSession: (sessionId) => ipcRenderer.invoke('acp:loadSession', { sessionId }),
  prompt: (sessionId, text) =>
    ipcRenderer.invoke('acp:prompt', { sessionId, text }),
  cancel: (sessionId) => ipcRenderer.invoke('acp:cancel', { sessionId }),
  onUpdate: (fn) => ipcRenderer.on('acp:update', (_e, params) => fn(params)),
  onError: (fn) => ipcRenderer.on('acp:error', (_e, params) => fn(params)),
  onExit: (fn) => ipcRenderer.on('acp:exit', (_e, params) => fn(params)),
  access: {
    get: () => ipcRenderer.invoke('access:get'),
    set: (mode) => ipcRenderer.invoke('access:set', { mode }),
    respond: (requestKey, optionId) =>
      ipcRenderer.invoke('access:respond', { requestKey, optionId }),
    onRequest: (fn) =>
      ipcRenderer.on('acp:permission', (_e, payload) => fn(payload)),
  },
});
