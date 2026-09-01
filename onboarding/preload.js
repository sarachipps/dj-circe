const { contextBridge, ipcRenderer, shell } = require('electron');
const log = require('electron-log/renderer');

Object.assign(console, log.functions);
window.addEventListener('error', (e) => {
  log.error('onboarding renderer error:', e.message, e.error && e.error.stack);
});
window.addEventListener('unhandledrejection', (e) => {
  log.error('onboarding renderer unhandledRejection:', e.reason);
});

contextBridge.exposeInMainWorld('onboarding', {
  hermesDetect: () => ipcRenderer.invoke('onboarding:hermesDetect'),
  hermesInstall: (onProgress) => {
    const listener = (_e, line) => onProgress && onProgress(line);
    ipcRenderer.on('onboarding:hermesInstall:progress', listener);
    return ipcRenderer.invoke('onboarding:hermesInstall').finally(() => {
      ipcRenderer.removeListener('onboarding:hermesInstall:progress', listener);
    });
  },
  bedrockDetectClaudeCode: () =>
    ipcRenderer.invoke('onboarding:bedrockDetectClaudeCode'),
  bedrockVerifyDirect: (apiKey, onRetry) => {
    const listener = (_e, p) => onRetry && onRetry(p);
    ipcRenderer.on('onboarding:bedrockVerify:retry', listener);
    return ipcRenderer.invoke('onboarding:bedrockVerifyDirect', { apiKey }).finally(() => {
      ipcRenderer.removeListener('onboarding:bedrockVerify:retry', listener);
    });
  },
  bedrockVerifyHermes: (slug) =>
    ipcRenderer.invoke('onboarding:bedrockVerifyHermes', { slug }),
  pickCharacter: (args) =>
    ipcRenderer.invoke('onboarding:pickCharacter', args),
  fetchAvatar: (args) =>
    ipcRenderer.invoke('onboarding:fetchAvatar', args),
  renderInitialsAvatar: (args) =>
    ipcRenderer.invoke('onboarding:renderInitialsAvatar', args),
  uploadAvatar: (args) =>
    ipcRenderer.invoke('onboarding:uploadAvatar', args),
  createOrchestrator: (args) =>
    ipcRenderer.invoke('onboarding:createOrchestrator', args),
  deleteProfile: (args) => ipcRenderer.invoke('onboarding:deleteProfile', args),
  mcpTest: (args) => ipcRenderer.invoke('onboarding:mcpTest', args),
  mcpApplyAtlassianSubset: (args) =>
    ipcRenderer.invoke('onboarding:mcpApplyAtlassianSubset', args),
  writeFirstTasks: (args) =>
    ipcRenderer.invoke('onboarding:writeFirstTasks', args),
  openExternal: (url) => shell.openExternal(url),
  copyToClipboard: (text) => ipcRenderer.invoke('onboarding:copyToClipboard', { text }),
  copyLastLogLines: () => ipcRenderer.invoke('onboarding:copyLastLogLines'),
  finish: (slug) => ipcRenderer.invoke('onboarding:finish', { slug }),
});
