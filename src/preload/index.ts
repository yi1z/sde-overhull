import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopAPI } from '../shared/types';
const methods = new Set([
  'window.close',
  'settings.get',
  'settings.save',
  'project.open',
  'project.create',
  'project.clone',
  'project.refresh',
  'project.trust',
  'design.save',
  'artifact.patch',
  'design.approve',
  'design.new',
  'design.history',
  'git.diff',
  'git.commit',
  'git.fetch',
  'git.pull',
  'git.push',
  'git.merge',
  'git.finishMerge',
  'git.conflict',
  'git.resolve',
  'agent.diagnostics',
  'agent.send',
  'agent.cancel',
  'agent.respond',
  'run.start',
  'run.cancel',
  'run.verify',
  'services.save',
  'services.start',
  'services.stop',
  'services.restart',
  'services.open',
  'services.env',
  'evaluation.save',
  'evaluation.attach',
]);
const api: DesktopAPI = {
  request: (method, params) => {
    if (!methods.has(method)) return Promise.reject(new Error('Unknown application action.'));
    return ipcRenderer.invoke('sde:request', method, params);
  },
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) => listener(event);
    ipcRenderer.on('sde:event', handler);
    return () => ipcRenderer.removeListener('sde:event', handler);
  },
};
contextBridge.exposeInMainWorld('sde', api);
