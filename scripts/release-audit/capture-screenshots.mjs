// Documentation-only fixtures and capture harness; excluded from the Windows app.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import { _electron as electron, expect } from '@playwright/test';
const root=process.cwd(),base=path.resolve('.release-local/screenshots-'+Date.now());fs.mkdirSync(base,{recursive:true});fs.mkdirSync('docs/screenshots',{recursive:true});
const allowed=/^(SystemRoot|SystemDrive|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|ProgramData|ALLUSERSPROFILE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.test(k)));env.MOMO_TEST_MODE='1';env.MOMO_TEST_DATA_DIR=base;
const app=await electron.launch({executablePath:path.resolve('release/win-unpacked/MoMo Community Preview.exe'),cwd:root,env,args:['--force-device-scale-factor=1'],timeout:30000});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const report={source:'Current packaged renderer and artwork; isolated disposable profile. Documentation-only IPC fixtures for Home, Relay and Situation; Dashboard/Mo/Work show the same fictional Relay attention item; account and task states remain empty.',viewport:{width:1920,height:1080},mainSha256:sha(fs.readFileSync('dist-electron/main.cjs')),rendererFiles:fs.readdirSync('dist/assets').filter(n=>/\.js$/.test(n)).map(file=>({file,sha256:sha(fs.readFileSync('dist/assets/'+file))})),captures:[]};
try{
 const page=await app.firstWindow();await page.locator('.sidebar').waitFor();
 const initial=await page.evaluate(async()=>({snapshot:await window.momo.getSnapshot(),home:await window.momo.homeCommand({action:'snapshot'}),relay:await window.momo.relayCommand({action:'snapshot'}),situation:await window.momo.situationCommand({action:'snapshot'})}));
 assert(initial.snapshot.ok);assert(Object.values(initial.snapshot.value.credentials).every(v=>v==='missing'));
 const saved=await page.evaluate(async revision=>window.momo.updateSettings({patch:{timezone:'UTC',assistantCollapsed:true,reducedMotion:true},expectedRevision:revision}),initial.snapshot.value.settings.revision);assert(saved.ok);
 const at='2026-10-04T14:00:00.000Z',id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const device={provider:'govee-lan',identity:'02:00:00:00:00:00:00:42',model:'H6000',endpoint:'192.168.254.42',interfaceId:'documentation-fixture',category:'light',capability:'documented-light',seenAt:at,availability:'observed',state:{power:true,brightness:65,at}};
 const home={...initial.home.value,config:{interfaceId:device.interfaceId,hueAddress:null},devices:[device],interfaces:[{id:device.interfaceId,name:'Demo network (simulated)',address:'192.168.254.2',netmask:'255.255.255.0'}],mapping:{identity:device.identity,model:device.model,endpoint:device.endpoint,interfaceId:device.interfaceId,alias:'Demo studio light',confirmedAt:at},permission:null,grant:null,hue:null,receipts:[],diagnostic:'Documentation example — simulated light; no real network or device.',checkedAt:at};
 const relay={...initial.relay.value,connection:'not-configured',lastSync:null,receipts:[{id:id(2),event:{version:1,eventId:'documentation-message',provider:'synthetic',providerAccount:'demo-account',channel:'sms',receiver:'Demo-workspace',sender:'Demo-studio',providerTimestamp:at,providerMessageId:'documentation-message',kind:'message',content:'Demo update: the workshop materials are ready for review.',authentication:{intakeId:id(3),mode:'synthetic',verifiedAt:at}},digest:'0'.repeat(64),dedup:'1'.repeat(64),receivedAt:at,rootRunId:null,continuationRevision:0,disposition:'held',reason:'unknown-sender',synthetic:true,duplicateCount:0,updatedAt:at,result:null,draft:null,approval:null,timeline:[{at,detail:'Documentation fixture only. No carrier connection or message delivery.'}]}],responsibilities:[],totalReceipts:1};
 const location={id:id(4),label:'Paris · demo',latitude:48.8566,longitude:2.3522,timezone:'Europe/Paris',purpose:'Public city example',revision:'documentation',updatedAt:at};
 const situation={...initial.situation.value,config:{...initial.situation.value.config,locations:[location],routes:[],timezones:[],trackedFlights:[],defaultLocationId:location.id,defaultRouteId:null,trafficEnabled:false,flightsEnabled:false,includeInBriefing:false,shareWithAI:false},selectedLocationId:location.id,selectedRouteId:null,weather:null,traffic:null,flights:null,conditions:[],usage:[],checkedAt:at};
 // Responses replace only this process's handlers; nothing is persisted to normal profiles.
 // No fixture can issue a Home control command, Relay send or weather/traffic fetch.
 await app.evaluate(({ipcMain},fixtures)=>{for(const [channel,value]of Object.entries(fixtures)){ipcMain.removeHandler(channel);ipcMain.handle(channel,()=>({ok:true,value}));}}, {'momo:home:command':home,'momo:relay:command':relay,'momo:situation:command':situation});
 await page.clock.setFixedTime(new Date(at));await page.reload();await page.locator('.sidebar').waitFor();
 await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setContentSize(1920,1080);window.webContents.setZoomFactor(1);});
 await page.waitForFunction(()=>innerWidth===1920&&innerHeight===1080);await expect(page.locator('.sidebar')).not.toHaveAttribute('inert','');
 const capture=async(file,module,route,mode,provenance)=>{
  await expect(page.locator('main')).toHaveAttribute('data-workspace',route);
  if(mode)await expect(page.locator('.assistant-host')).toHaveAttribute('data-mode',mode);
  await page.evaluate(()=>document.fonts.ready);await page.locator('.workspace-notice').waitFor({state:'hidden',timeout:10000});
  await page.screenshot({path:`docs/screenshots/${file}.png`,animations:'disabled',scale:'css'});
  const bytes=fs.readFileSync(`docs/screenshots/${file}.png`);assert.equal(bytes.readUInt32BE(16),1920);assert.equal(bytes.readUInt32BE(20),1080);
  report.captures.push({file:file+'.png',module,actualRoute:await page.locator('main').getAttribute('data-workspace'),heading:await page.locator('.topbar>strong').innerText(),visibleHeadings:await page.locator('h1:visible,h2:visible').allTextContents(),paneMode:await page.locator('.assistant-host').getAttribute('data-mode'),viewport:report.viewport,sha256:sha(bytes),provenance});
 };
 await capture('dashboard','Dashboard','dashboard',null,'Empty account/task profile with the fictional Relay attention item from the documentation fixture; no saved places or clocks.');
 await page.getByRole('button',{name:'Show assistant',exact:true}).click();await capture('mo','Mo','dashboard','assistant','Empty Mo pane; AI requests disabled and no provider key.');
 await page.getByRole('navigation',{name:'Right workpane'}).getByRole('button',{name:'Work',exact:true}).click();await capture('work','Work','dashboard','activity','Honest empty Work and approval state.');
 await page.getByRole('button',{name:'Close work',exact:true}).click();
 for(const [label,route,file]of [['Inbox','inbox','inbox'],['Planner','planner','planner'],['Situation View','situation','situation'],['Relay','relay','relay'],['Home Automation','home-automation','home'],['Settings','settings','settings']]){
  await page.locator('.sidebar').getByRole('button',{name:label,exact:true}).click();await expect(page.locator('.topbar>strong')).toHaveText(label);
  if(file==='home'){await page.getByRole('button',{name:/Demo studio light/}).click();await expect(page.getByText('Demo studio light',{exact:true}).first()).toBeVisible();}
  if(file==='relay'){await page.getByRole('button',{name:/Demo-studio/}).click();await expect(page.getByText('SYNTHETIC ISOLATED ACCEPTANCE',{exact:true})).toBeVisible();}
  if(file==='situation'){await expect(page.getByText('Paris · demo',{exact:true}).first()).toBeVisible();await page.waitForTimeout(3500);}
  await capture(file,label,route,null,file==='home'?'Documentation-only simulated mapped light (H6000), no live discovery or control.':file==='relay'?'Documentation-only synthetic held message; provider remains unconfigured.':file==='situation'?'Documentation-only public Paris city coordinate; no saved route, private clock, weather or traffic data.':'Honest empty/setup state; UTC demo preference.');
 }
 assert.equal(new Set(report.captures.map(c=>c.sha256)).size,report.captures.length,'Duplicate screenshots');
 fs.writeFileSync('docs/screenshots/manifest.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.captures.map(c=>({file:c.file,route:c.actualRoute,heading:c.heading}))));
}finally{await app.close();fs.writeFileSync(path.join(base,'capture-report.json'),JSON.stringify(report,null,2));}
