import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import { spawn } from 'node:child_process';import { chromium, expect } from '@playwright/test';
const base=path.resolve('.release-local/network-audit-'+Date.now());fs.mkdirSync(base,{recursive:true});
const allowed=/^(SystemRoot|SystemDrive|WINDIR|COMSPEC|PATH|PATHEXT|TEMP|TMP|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|ProgramData|ALLUSERSPROFILE|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|USERPROFILE|APPDATA|LOCALAPPDATA)$/i;
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.test(k)));env.MOMO_TEST_MODE='1';env.MOMO_TEST_DATA_DIR=base;
const executable=path.resolve('release/win-unpacked/MoMo Community Preview.exe');
const child=spawn(executable,['--inspect-brk=127.0.0.1:0','--remote-debugging-port=0','--force-device-scale-factor=1','--log-net-log='+path.join(base,'chromium-netlog.json')],{cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stderr='',socket,browser,observer;child.stderr.on('data',c=>{stderr+=c;fs.appendFileSync(path.join(base,'stderr.log'),c);});
const until=async fn=>{const end=Date.now()+30000;while(!fn()){if(Date.now()>end)throw Error('Audit condition timed out');await new Promise(r=>setTimeout(r,100));}return fn();};
let seq=0,paused;const pending=new Map();let send;
const report={started:Date.now(),executableSha256:crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),method:'Unmodified package; inspector before first app statement; native pass-through API observation, Chromium netlog, PID-bound TCP/UDP sampling. No offline/network-disable flags. Empty test-directory override only.',checks:{},views:[]};
try{
 const url=await until(()=>stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]);socket=new WebSocket(url);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
 socket.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id)pending.get(m.id)?.(m);else if(m.method==='Debugger.paused')paused=m.params;});
 send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('Inspector timeout: '+method)),20000);pending.set(id,m=>{clearTimeout(timer);pending.delete(id);if(m.error)reject(Error(JSON.stringify(m.error)));else resolve(m.result);});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
 await send('Runtime.enable');await send('Debugger.enable');await send('Runtime.runIfWaitingForDebugger');await until(()=>paused);
 const source=await send('Debugger.getScriptSource',{scriptId:paused.callFrames[0].location.scriptId});assert(source.scriptSource===fs.readFileSync('dist-electron/main.cjs','utf8'),'Paused script must equal packaged main build');
 const hook=fs.readFileSync('scripts/release-audit/native-probe.cjs','utf8')+'\nglobalThis.__auditElectron=require("electron");';
 const injected=await send('Debugger.evaluateOnCallFrame',{callFrameId:paused.callFrames[0].callFrameId,expression:'(()=>{'+hook+'})()',returnByValue:true});assert(!injected.exceptionDetails);report.checks.probeBeforeApplication=true;
 observer=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/release-audit/observe-processes.ps1'),'-RootProcessId',String(child.pid),'-OutputDirectory',base],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});observer.stderr.on('data',c=>fs.appendFileSync(path.join(base,'observer-errors.log'),c));
 await until(()=>fs.existsSync(path.join(base,'observer-ready')));
 await send('Debugger.setSkipAllPauses',{skip:true});await send('Debugger.resume');
 const browserUrl=await until(()=>stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);browser=await chromium.connectOverCDP(browserUrl);
 await until(()=>browser.contexts()[0]?.pages().length);const page=browser.contexts()[0].pages()[0];await page.locator('.sidebar').waitFor({timeout:20000});
 report.runtime=await evaluate('({packaged:__auditElectron.app.isPackaged,userData:__auditElectron.app.getPath("userData"),versions:process.versions})');assert(report.runtime.packaged);assert.equal(report.runtime.userData,base);delete report.runtime.userData;
 const state=await page.evaluate(async()=>({snapshot:await window.momo.getSnapshot(),workspace:await window.momo.getWorkspace(),home:await window.momo.homeCommand({action:'snapshot'}),situation:await window.momo.situationCommand({action:'snapshot'}),relay:await window.momo.relayCommand({action:'snapshot'})}));
 fs.writeFileSync(path.join(base,'initial-state.json'),JSON.stringify(state,null,2));
 assert(state.snapshot.ok);const s=state.snapshot.value;assert(Object.values(s.credentials).every(v=>v==='missing'));assert.equal(s.google.accounts.length,0);assert.equal(s.google.configuration,'missing');assert.equal(s.aiRequestsEnabled,false);assert.notEqual(s.settings.values.desktopObservation?.enabled,true);assert.notEqual(s.settings.values.backgroundIntelligence?.enabled,true);
 for(const key of ['interfaceId','hueAddress'])assert.equal(state.home.value.config[key],null);for(const key of ['mapping','grant'])assert.equal(state.home.value[key],null);assert.equal(state.home.value.devices.length,0);
 for(const key of ['locations','routes','timezones','trackedFlights'])assert.equal(state.situation.value.config[key].length,0);
 assert.equal(state.workspace.value.runs.length,0);assert.equal(state.workspace.value.tasks.length,0);report.checks.emptyProfile=true;
 await evaluate('__auditElectron.BrowserWindow.getAllWindows()[0].setContentSize(1920,1080);true');
 await page.waitForFunction(()=>window.innerWidth===1920&&window.innerHeight===1080);
 await expect(page.locator('.sidebar')).not.toHaveAttribute('inert', '', {timeout:10000});
 const view=async(label,route,mode)=>{
  await evaluate('globalThis.__momoNetworkAudit.phase='+JSON.stringify(label));
  if(route){await page.locator('.sidebar').getByRole('button',{name:label,exact:true}).click();await expect(page.locator('main')).toHaveAttribute('data-workspace',route);await expect(page.locator('.topbar>strong')).toHaveText(label);}
  if(mode){await page.getByRole('navigation',{name:'Right workpane'}).getByRole('button',{name:mode,exact:true}).click();await expect(page.locator('.assistant-host')).toHaveAttribute('data-mode',mode==='Mo'?'assistant':'activity');}
  report.views.push({module:label,route:await page.locator('main').getAttribute('data-workspace'),heading:await page.locator('.topbar>strong').innerText(),mode:await page.locator('.assistant-host').getAttribute('data-mode')});
  await page.waitForTimeout(2000); // Deliberate observation interval, after navigation assertions.
 };
 await view('Dashboard','dashboard');await view('Mo',null,'Mo');await view('Work',null,'Work');
 for(const [label,route]of [['Inbox','inbox'],['Planner','planner'],['Situation View','situation'],['Relay','relay'],['Home Automation','home-automation'],['Settings','settings']])await view(label,route);
 report.productObservationEnded=Date.now();report.native=await evaluate('globalThis.__momoNetworkAudit');
 // Canary phase is separate from product observations. Only loopback destinations.
 report.canaryStarted=Date.now();
 report.canary=await evaluate(`(async()=>{
  const a=__momoNetworkAudit;a.phase='canary';const r=__auditRequire;const http=r('node:http'),net=r('node:net'),udp=r('node:dgram');
  const server=http.createServer((q,s)=>{s.end('audit');});server.on('upgrade',(q,s)=>s.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n'));await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const port=server.address().port;
  const tcp=net.createServer(s=>s.on('error',()=>{}));await new Promise(ok=>tcp.listen(0,'127.0.0.1',ok));const tcpPort=tcp.address().port;const connection=net.connect(tcpPort,'127.0.0.1');connection.on('error',()=>{});
  const datagram=udp.createSocket('udp4');await new Promise(ok=>datagram.bind(0,'127.0.0.1',ok));datagram.on('message',(msg,peer)=>{if(msg.length>12){msg[2]=0x81;msg[3]=0x83;datagram.send(msg,peer.port,peer.address);}});datagram.send(Buffer.from('audit'),datagram.address().port,'127.0.0.1');
  await fetch('http://127.0.0.1:'+port);await new Promise(ok=>http.get('http://127.0.0.1:'+port,s=>{s.resume();s.on('end',ok);}));
  await new Promise(ok=>r('node:https').get('https://127.0.0.1:'+port,{rejectUnauthorized:false},()=>ok()).on('error',ok));
  await r('node:dns').promises.lookup('localhost');const resolver=new(r('node:dns').promises.Resolver)();resolver.setServers(['127.0.0.1:'+datagram.address().port]);await resolver.resolve4('audit.invalid').catch(()=>{});
  const ws=new WebSocket('ws://127.0.0.1:'+port);ws.addEventListener('error',()=>{});
  const cp=r('node:child_process').spawn(${JSON.stringify(process.execPath)},['-e','const s=require("net").connect('+tcpPort+',"127.0.0.1");s.on("error",()=>{});setTimeout(()=>s.destroy(),5000);'],{windowsHide:true,stdio:'ignore'});
  await new Promise(ok=>setTimeout(ok,6500));connection.destroy();datagram.close();tcp.close();server.closeAllConnections();server.close();
  return {port,tcpPort,childPid:cp.pid,events:a.events.filter(e=>e.phase==='canary'),children:a.children.filter(e=>e.phase==='canary')};
 })()`);
 for(const family of ['fetch','http.get','https.get','net.connect','tls.connect','dns.lookup','dns.resolve4','dgram.send','WebSocket'])assert(report.canary.events.some(e=>e.kind===family),'Canary missing '+family);
 report.checks.nativeCanary=true;
 console.log(JSON.stringify({views:report.views,nativeProductEvents:report.native.events,canaryKinds:[...new Set(report.canary.events.map(e=>e.kind))]}));
}catch(error){report.failure=error.message;process.exitCode=1;console.error(error.message);}finally{
 if(send)await send('Runtime.evaluate',{expression:'setTimeout(()=>__auditElectron.app.quit(),0);true'}).catch(()=>{});socket?.close();
 await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>{if(child.exitCode===null)child.kill();r();},10000);});await browser?.close().catch(()=>{});
 fs.writeFileSync(path.join(base,'observer-stop'),'stop');if(observer)await new Promise(r=>{if(observer.exitCode!==null)return r();observer.once('exit',r);setTimeout(r,10000);});
 try{report.os=JSON.parse(fs.readFileSync(path.join(base,'process-sockets.json'),'utf8').replace(/^\uFEFF/,''));report.checks.osCanary=report.os.sockets.some(s=>s.protocol==='tcp'&&s.remotePort===report.canary?.tcpPort&&s.pid===child.pid)&&report.os.sockets.some(s=>s.pid===report.canary?.childPid&&s.remotePort===report.canary?.tcpPort);assert(report.checks.osCanary,'OS observer failed main/child canary');}catch(e){report.failure??=e.message;process.exitCode=1;}
 try{const log=JSON.parse(fs.readFileSync(path.join(base,'chromium-netlog.json'),'utf8'));const types=Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k,v])=>[v,k]));const hosts=new Set(),counts={};for(const event of log.events??[]){const type=types[event.type];counts[type]=(counts[type]??0)+1;const raw=event.params?.url;if(typeof raw!=='string')continue;try{const u=new URL(raw);if(['http:','https:','ws:','wss:'].includes(u.protocol))hosts.add(u.hostname);}catch{}}report.chromiumRequestHosts=[...hosts];report.chromiumEventCounts=counts;report.checks.completeChromiumLog=true;}catch{report.failure??='Incomplete Chromium log';process.exitCode=1;}
 report.ended=Date.now();fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync('artifacts-public/network-audit-latest.json',JSON.stringify({directory:base,...report},null,2));console.log(JSON.stringify({checks:report.checks,chromiumRequestHosts:report.chromiumRequestHosts,failure:report.failure,evidence:path.basename(base)}));
}
