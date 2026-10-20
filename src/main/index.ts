import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application } from './application';
const here = path.dirname(fileURLToPath(import.meta.url));
const smokeTest = process.argv.includes('--smoke-test');
const userDataArgument = process.argv.find((argument) => argument.startsWith('--user-data-dir='));
if (userDataArgument)
  app.setPath('userData', path.resolve(userDataArgument.slice('--user-data-dir='.length)));
let window: BrowserWindow | undefined;
let application: Application | undefined;
let exiting = false;
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      application = new Application(app.getPath('userData'), {
        chooseDirectory: async () => {
          const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
          return result.canceled ? undefined : result.filePaths[0];
        },
        chooseFile: async () => {
          const result = await dialog.showOpenDialog({ properties: ['openFile'] });
          return result.canceled ? undefined : result.filePaths[0];
        },
        openExternal: async (url) => {
          await shell.openExternal(url);
        },
        event: (event) => window?.webContents.send('sde:event', event),
      });
      window = new BrowserWindow({
        width: 1480,
        height: 960,
        minWidth: 1000,
        minHeight: 680,
        show: false,
        backgroundColor: '#0d1117',
        title: 'Overhull',
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(here, '../preload/index.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      ipcMain.handle('sde:request', async (event, method, params) => {
        if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
          throw new Error('Untrusted application frame.');
        return application!.request(method, params);
      });
      window.once('ready-to-show', () => {
        if (!smokeTest) window?.show();
      });
      if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL);
      else await window.loadFile(path.join(here, '../renderer/index.html'));
      if (smokeTest) {
        // Exercise the packaged renderer and sandboxed preload, without opening a repository.
        const ready = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const started = Date.now();
          const check = async () => {
            if (document.querySelector('#root')?.textContent.toLowerCase().includes('overhull') && window.sde) {
              try { const settings = await window.sde.request('settings.get'); resolve(settings.theme !== undefined); }
              catch (error) { reject(error); }
            } else if (Date.now() - started > 15000) reject(new Error('Renderer did not become ready'));
            else setTimeout(check, 100);
          }; check();
        })`);
        if (!ready) throw new Error('Packaged settings IPC failed.');
        console.log('OVERHULL_SMOKE_OK');
        app.quit();
      }
    })
    .catch((error) => {
      console.error(error);
      if (!smokeTest) dialog.showErrorBox('Overhull could not start', String(error));
      app.exit(1);
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    void Promise.resolve(application?.dispose()).finally(() => app.quit());
  });
}
