import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application } from './application';
const here=path.dirname(fileURLToPath(import.meta.url));
const userDataArgument=process.argv.find(argument=>argument.startsWith('--user-data-dir='));
if(userDataArgument)app.setPath('userData',path.resolve(userDataArgument.slice('--user-data-dir='.length)));
let window:BrowserWindow|undefined;
let application:Application|undefined;
let exiting=false;
const single=app.requestSingleInstanceLock();
if(!single)app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    application=new Application(app.getPath('userData'),{
      chooseDirectory:async()=>{const result=await dialog.showOpenDialog({properties:['openDirectory','createDirectory']});return result.canceled?undefined:result.filePaths[0];},
      chooseFile:async()=>{const result=await dialog.showOpenDialog({properties:['openFile']});return result.canceled?undefined:result.filePaths[0];},
      openExternal:async(url)=>{await shell.openExternal(url);},
      event:event=>window?.webContents.send('sde:event',event)
    });
    window=new BrowserWindow({width:1480,height:960,minWidth:1000,minHeight:680,show:false,backgroundColor:'#0d1117',title:'Overhull',autoHideMenuBar:true,webPreferences:{preload:path.join(here,'../preload/index.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    ipcMain.handle('sde:request',async(event,method,params)=>{
      if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Untrusted application frame.');
      return application!.request(method,params);
    });
    window.once('ready-to-show',()=>window?.show());
    if(process.env.ELECTRON_RENDERER_URL)await window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else await window.loadFile(path.join(here,'../renderer/index.html'));
  }).catch(error=>{console.error(error);dialog.showErrorBox('Overhull could not start',String(error));app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{if(exiting)return;event.preventDefault();exiting=true;void application?.dispose().finally(()=>app.quit());});
}
