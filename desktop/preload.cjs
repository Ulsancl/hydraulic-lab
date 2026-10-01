const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hydraulicDesktop', {
  isDesktop: true,
  openProject: () => ipcRenderer.invoke('hydraulic:open-project'),
  saveProject: payload => ipcRenderer.invoke('hydraulic:save-project', payload),
  setBusy: busy => ipcRenderer.send('hydraulic:busy', busy === true),
  onCommand: callback => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('hydraulic:command', listener);
    return () => ipcRenderer.removeListener('hydraulic:command', listener);
  },
});
