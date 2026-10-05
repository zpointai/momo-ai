import {Menu,type BrowserWindow,type MenuItemConstructorOptions,type ContextMenuParams} from 'electron';

export function contextEditItems(params:Pick<ContextMenuParams,'isEditable'|'editFlags'>):MenuItemConstructorOptions[] {
  const f=params.editFlags;
  if(!params.isEditable)return [{role:'copy',enabled:f.canCopy}];
  // Chromium's edit flags disable copying/cutting password fields. No secret is read.
  return [{role:'undo',enabled:f.canUndo},{role:'redo',enabled:f.canRedo},{type:'separator'},
    {role:'cut',enabled:f.canCut},{role:'copy',enabled:f.canCopy},{role:'paste',enabled:f.canPaste},
    {type:'separator'},{role:'selectAll',enabled:f.canSelectAll}];
}
export function installEditMenu(window:BrowserWindow) {
  // On Windows hidden menu items retain accelerators. No application/global hotkey.
  window.setMenu(Menu.buildFromTemplate([{label:'Edit',visible:false,submenu:[
    {role:'undo',accelerator:'CommandOrControl+Z'},{role:'redo',accelerator:'CommandOrControl+Y'},
    {role:'cut',accelerator:'CommandOrControl+X'},{role:'copy',accelerator:'CommandOrControl+C'},
    {role:'paste',accelerator:'CommandOrControl+V'},
  ]}]));
  window.setMenuBarVisibility(false);
  window.webContents.on('context-menu',(_event,params)=>{
    if(window.isDestroyed()||window.webContents.isDestroyed())return;
    Menu.buildFromTemplate(contextEditItems(params)).popup({window});
  });
}
