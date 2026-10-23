'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (action, value) => {
  const result = await ipcRenderer.invoke('paceline:action', action, value);
  // The sandboxed preload cannot load translations; an empty message lets the renderer use its own.
  if (result?.ok === false) throw new Error(result.error || '');
  return result;
};
contextBridge.exposeInMainWorld('paceline', Object.freeze({
  getState: () => ipcRenderer.invoke('paceline:state'),
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('paceline:state', listener);
    return () => ipcRenderer.removeListener('paceline:state', listener);
  },
  expand: value => invoke('expand', Boolean(value)),
  pin: value => invoke('pin', Boolean(value)),
  refresh: () => invoke('refresh'),
  connectCodex: () => invoke('connectCodex'),
  loginClaude: () => invoke('loginClaude'),
  installClaudeBridge: () => invoke('installClaudeBridge'),
  removeClaudeBridge: () => invoke('removeClaudeBridge'),
  getAnalytics: options => invoke('getAnalytics', options),
  getLocalUsage: () => invoke('getLocalUsage'),
  moveOverlay: value => invoke('moveOverlay', value),
  checkForUpdates: () => invoke('checkForUpdates'),
  downloadUpdate: () => invoke('downloadUpdate'),
  installUpdate: () => invoke('installUpdate'),
  openDataFolder: () => invoke('openDataFolder'),
  openUsage: provider => invoke('openUsage', provider),
  updateSettings: value => invoke('updateSettings', value),
  quit: () => invoke('quit')
}));
