import { HomeAutomationService } from './home-automation/service';
import { FileHomeStore } from './home-automation/store';
import {inboxEvents,calendarEvents,taskEvents} from './agent/proactive';
import { allowedSituationLink } from './security';
import { hash } from './agent/catalogue';
import { SituationStore } from './situation/store';
import { SituationService } from './situation/service';
import { situationCommandSchema } from '../src/shared/situation';
import { BackgroundStore } from './agent/background-store';
import { BriefingStore } from './agent/briefing-store';
import {installEditMenu} from './edit-menu';
import { MailService } from './mail/service';
import { mailCommandSchema } from '../src/shared/mail';
import { workflowModule, type ModuleId } from '../src/shared/modules';
import { OrchestrationService } from './agent/service';
import { agentCommandSchema } from '../src/shared/orchestration';
import { CalendarActionService } from './calendar/service';
import { calendarActionCommandSchema } from '../src/shared/calendar-actions';
import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, session, shell, screen, powerMonitor } from 'electron';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { channels, providerSchema, settingsUpdateSchema, snapshotSchema, saveCredentialSchema, type Snapshot } from '../src/shared/contracts';
import { AssistantService } from './ai/service';
import { MoContext } from './ai/mo-context';
import { taskCommandSchema, runRequestSchema } from '../src/shared/assistant';
import { StorageClient } from './storage/client';
import { CredentialStore } from './credentials/store';
import { RelayTransport } from './relay/transport';
import { DesktopVoice } from './relay/voice';
import { RelayVault } from './relay/vault';
import { secureRelayEntry } from './relay/secure-entry';
import { allowedRequest, appOrigin, assetPath, devOrigin, isTrustedSender, productionCsp } from './security';
import { invokeOperation } from './ipc/operations';
import { AppError } from './errors';
import { GoogleService } from './google/service';
import { GoogleHttp } from './google/http';
import { ProtectedGoogleVault } from './google/vault';
import { googleCommandSchema, inboxQuerySchema, messageQuerySchema, calendarQuerySchema } from '../src/shared/google';
import { restoreWindow, rememberWindow } from './window-state';
import { DesktopObservationService } from './desktop-observation/service';
import { WindowsObservationHelper, builtHelperIdentity } from './desktop-observation/helper-client';
import { relaySessionPolicy } from './relay/session';

// Session-only acceptance guard: no saved permissions or schedules are changed.
if(process.argv.includes('--offline-review'))globalThis.fetch=async()=>{throw new AppError('unavailable','Network access is disabled for this local review session.');};
app.setName('MoMo Community Preview');
const development = !app.isPackaged && process.argv.includes('--dev');
// Session-only desktop review: preserve saved schedules while suppressing background dispatch.
const relaySynthetic = process.env.MOMO_TEST_MODE === '1' && process.env.MOMO_RELAY_TEST_MODE === '1' && !!process.env.MOMO_TEST_DATA_DIR && path.resolve(process.env.MOMO_TEST_DATA_DIR).toLowerCase() !== path.join(app.getPath('appData'),'MoMo-community-preview').toLowerCase();
const {backgroundWorkAllowed,relayNetworkAllowed,relayOutboundAllowed}=relaySessionPolicy(process.argv);
if (process.env.MOMO_TEST_MODE === '1' && process.env.MOMO_TEST_DATA_DIR) app.setPath('userData', path.resolve(process.env.MOMO_TEST_DATA_DIR));
else app.setPath('userData', path.join(app.getPath('appData'), app.isPackaged ? 'MoMo-community-preview' : 'MoMo-community-preview-development'));
// Chromium session storage follows the isolated public profile too.
app.setPath('sessionData', app.getPath('userData'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
let window: BrowserWindow | null = null;
let storage: StorageClient | null = null;
let shuttingDown = false;
let credentialsBusy = false;
let google: GoogleService | null = null;
let assistant: AssistantService | null = null;
let orchestration:OrchestrationService|null=null;
let relayTransport:RelayTransport|null=null;
let desktopVoice:DesktopVoice|null=null;
let homeAutomation:HomeAutomationService|null=null;
let scheduler:NodeJS.Timeout|undefined;
let desktopObservation: DesktopObservationService | null = null;
let observationRendererGeneration = 0;
let observationContextGeneration = 0;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('MoMo could not start', 'Local storage could not be opened. Your data has been preserved. Close other MoMo instances or restore a verified backup.');
    app.quit();
  });
}
async function start() {
  const data = app.getPath('userData');
  await mkdir(data, { recursive: true });
  const ownerProfile=path.join(app.getPath('appData'),'MoMo-community-preview'),ownerReal=await realpath(ownerProfile).catch(()=>ownerProfile);
  const relativeProfile=path.relative(ownerReal.toLowerCase(),(await realpath(data)).toLowerCase());
  const isolatedRelay=relaySynthetic&&(relativeProfile.startsWith('..'+path.sep)||relativeProfile==='..'||path.isAbsolute(relativeProfile));
  storage = new StorageClient(path.join(__dirname, 'storage-worker.cjs'), path.join(data, 'momo.sqlite'), process.argv.includes('--relay-setup-only'));
  await storage.ready;
  homeAutomation=new HomeAutomationService(new FileHomeStore(path.join(data,'home-automation-v1.json')),{
    enabled:async()=>!(await storage!.get()).values.disabledModules.includes('home-automation'),
    visible:()=>!!window&&!window.isDestroyed()&&window.isVisible()&&!window.isMinimized()&&window.isFocused(),
    confirm:async(title,message,detail)=>{if(!window||window.isDestroyed())return false;const result=await dialog.showMessageBox(window,{type:'question',title,message,detail,buttons:['Cancel','Confirm'],defaultId:0,cancelId:0});return result.response===1;},
  });
  const credentials = new CredentialStore(path.join(data, 'credentials'), safeStorage);
  const situation = new SituationService(new SituationStore(path.join(data, 'situation-v1.json')), credentials, async()=>({enabled:!(await storage!.get()).values.disabledModules.includes('situation'),network:!process.argv.includes('--no-situation-requests'),weatherOnly:process.argv.includes('--situation-weather-only')}), Date.now, undefined, async()=>{
    if(credentialsBusy)throw new AppError('unavailable','A credential operation is already open.');
    credentialsBusy=true;
    try{
      if(!credentials.available())throw new AppError('unavailable','Windows credential protection is unavailable. No key was saved.');
      const choice=await dialog.showOpenDialog(window!,{title:'Import TomTom key — remove the original text file after setup',buttonLabel:'Store locally',properties:['openFile'],filters:[{name:'Key text file',extensions:['txt','key']}]});
      if(choice.canceled||choice.filePaths.length!==1)throw new AppError('cancelled','Key import cancelled.');
      await credentials.importFile('tomtom',choice.filePaths[0]);
    }finally{credentialsBusy=false;}
  });
  const snapshot = async (): Promise<Snapshot> => {
    const settings=await storage!.get(),googleState=await google!.state();
    const aiRequestsEnabled=settings.values.deepseekEnabled||settings.values.jevEnabled||settings.values.executiveModel==='gpt-6-luna';
    return snapshotSchema.parse({
    openaiVerification:await assistant?.openAIVerification()??null,
    version: app.getVersion(), settings,
    credentials: Object.fromEntries(await Promise.all(providerSchema.options.map(async provider => [provider, await credentials.status(provider)]))),
    protectionAvailable: credentials.available(), networkEnabled: googleState.accounts.some(account => account.status === 'connected') || aiRequestsEnabled, aiRequestsEnabled, storage: 'ready', google: googleState,
    });
  };
  const changed = () => { void snapshot().then(value => { if (window && !window.isDestroyed()) window.webContents.send(channels.changed, value); }).catch(() => undefined); };
  google = new GoogleService(new ProtectedGoogleVault(path.join(data, 'credentials', 'google.bin'), safeStorage), new GoogleHttp(), url => shell.openExternal(url), changed);
  const moContext=new MoContext(storage,google,situation);
  assistant = new AssistantService(storage, credentials, google, value => { if (window && !window.isDestroyed()) window.webContents.send(channels.workspaceChanged, value); changed(); },undefined,undefined,undefined,moContext);
  let inboxEnabled=!(await storage!.get()).values.disabledModules.includes('inbox');
  const mail=new MailService(storage,google,()=>inboxEnabled&&!orchestration!.paused());
  const calendarActions = new CalendarActionService(storage, google, Date.now, ()=>!orchestration!.paused());
  assistant.setVoiceCalendar(calendarActions,()=>google!.calendarEpoch());
  calendarActions.setWorkflowValidator(action=>orchestration!.validateSchedulingCalendar(action));
  mail.setWorkflowValidator(draft=>orchestration!.validateSchedulingDraft(draft));
  orchestration=new OrchestrationService(storage,credentials,google,value=>{if(window&&!window.isDestroyed()){window.webContents.send(channels.agentChanged,value);void storage!.workspace().then(workspace=>window?.webContents.send(channels.workspaceChanged,workspace));}},undefined,undefined,Date.now,mail,new BriefingStore(path.join(data,'daily-intelligence-v1.json')),calendarActions,new BackgroundStore(path.join(data,'background-intelligence-v1.json')),situation,isolatedRelay);
  if(isolatedRelay)Object.defineProperty(globalThis,'__momoRelayTest',{value:(input:unknown)=>orchestration!.receiveRelay(input)});
  await orchestration.ready;
  assistant.setExecutive(orchestration.moExecutive(moContext));
  orchestration.connectMo(assistant);
  google.setNativeObservation(value=>{void orchestration!.observeNative('messages' in value?inboxEvents(value):calendarEvents(value)).catch(()=>undefined);});
  const relayChanged=()=>{void orchestration!.snapshot(true).then(value=>{if(window&&!window.isDestroyed())window.webContents.send(channels.agentChanged,value);}).catch(()=>{});};
  relayTransport=new RelayTransport(data,new RelayVault(path.join(data,'credentials'),safeStorage),storage,event=>orchestration!.receiveRelayFromGateway(event),relayChanged,async()=>relayNetworkAllowed&&!(await storage!.get()).values.disabledModules.includes('relay'),async purpose=>{if(credentialsBusy)throw new AppError('unavailable','A secure setup window is already open.');credentialsBusy=true;try{if(!window||window.isDestroyed())throw new AppError('unavailable','Open MoMo before secure setup.');if(window.isMinimized())window.restore();window.focus();window.setEnabled(false);return await secureRelayEntry(purpose,{resourceRoot:app.isPackaged?process.resourcesPath:__dirname,ownerWindow:window.getNativeWindowHandle().readBigUInt64LE().toString()});}finally{credentialsBusy=false;if(window&&!window.isDestroyed()){window.setEnabled(true);window.focus();}}},async()=>{if(!relayOutboundAllowed)throw new AppError('permission_denied','Outbound SMS is disabled in this Relay setup session.');const response=await dialog.showMessageBox(window!,{type:'warning',title:'Authorize live Relay sending',message:'Enable owner-approved SMS for this session?',detail:'Twilio Campaign readiness has been verified. This authorizes live sending for up to 30 minutes, subject to current readiness and an exact review for each message. Carrier charges may apply. No message is sent by this confirmation.',buttons:['Keep disabled','Authorize live sending'],defaultId:0,cancelId:0});return response.response===1;},undefined,Date.now,isolatedRelay);
  if(isolatedRelay)Object.defineProperty(globalThis,'__momoRelayTransportTest',{value:relayTransport});
  if(relayNetworkAllowed)relayTransport.start();
  desktopVoice=new DesktopVoice(async()=>{if(orchestration!.paused())return null;return relayTransport!.voiceConnection();},assistant,relayChanged,async(id,at)=>{for(const run of (await storage!.workspace()).runs){if(run.channel?.voice?.id===id){run.channel.voice.endedAt=at;await storage!.saveRun(run);}}});
  relayTransport.setVoiceSnapshot(()=>desktopVoice!.snapshot());
  if(relayNetworkAllowed)desktopVoice.start();

  desktopObservation = new DesktopObservationService({
    authority: async () => {
      const settings = await storage!.get();
      return { enabled: settings.values.desktopObservation?.enabled === true, paused: orchestration!.paused(), policyRevision: settings.revision, contextKey: String(observationContextGeneration) };
    },
    helper: invalidated => new WindowsObservationHelper({
      resourceRoot: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'dist-electron'),
      identity: builtHelperIdentity(), invalidated,
    }),
    confirm: async (kind, target) => {
      if (!window || window.isDestroyed()) return false;
      const label = target?.application.state === 'known' ? target.application.value : 'Unknown application';
      const answer = await dialog.showMessageBox(window, {
        type: 'question', buttons: ['Cancel', 'Allow observation'], defaultId: 0, cancelId: 0,
        message: kind === 'begin' ? 'Begin a desktop observation session?' : `Observe ${label}, window ${target?.windowOrdinal ?? 1}?`,
        detail: 'Read bounded accessibility labels and state for up to five minutes. This does not allow AI sharing, typing, clicks, focus changes or application control.',
      });
      return answer.response === 1;
    },
  });
  const invalidateSystemObservation = () => desktopObservation?.invalidate('SYSTEM_SESSION_CHANGED');
  powerMonitor.on('lock-screen', invalidateSystemObservation);
  powerMonitor.on('suspend', invalidateSystemObservation);
  powerMonitor.on('shutdown', invalidateSystemObservation);

  if(backgroundWorkAllowed)scheduler=setInterval(()=>{void orchestration?.tick().catch(()=>{});},60000);
  powerMonitor.on('resume',()=>{if(window&&!window.isDestroyed())window.webContents.send('momo:clock:changed');if(backgroundWorkAllowed)void orchestration?.resume().catch(()=>{});});

  const assetRoot = path.join(app.getAppPath(), 'dist');
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf':'font/ttf', '.ico':'image/x-icon' };
  protocol.handle('app', async request => {
    const file = assetPath(request.url, assetRoot);
    if (!file || request.method !== 'GET') return new Response('Not found', { status: 404 });
    try {
      const canonical = await realpath(file);
      const canonicalRoot = await realpath(assetRoot);
      if (!canonical.startsWith(canonicalRoot + path.sep)) return new Response('Not found', { status: 404 });
      return new Response(new Uint8Array(await readFile(canonical)), { headers: { 'Content-Type': types[path.extname(file)], 'Content-Security-Policy': productionCsp, 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowedRequest(details.url, development) }));
  const windowFile = path.join(data, 'window.json');
  const { maximized, ...bounds } = restoreWindow(windowFile, screen.getAllDisplays());
  window = new BrowserWindow({
    ...bounds, icon:path.join(app.getAppPath(),'dist','brand','momo-app-amber.ico'), minWidth: 800, minHeight: 620, show: false, backgroundColor: '#100e0b', title: 'MoMo',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged },
  });
  installEditMenu(window);
  if (maximized) window.maximize();
  rememberWindow(window, windowFile);
  window.webContents.setWindowOpenHandler(({url}) => { if(allowedSituationLink(url))void shell.openExternal(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { homeAutomation?.stop(); ++observationRendererGeneration; desktopObservation?.invalidate('RENDERER_CHANGED'); }
  });
  window.on('hide',()=>homeAutomation?.stop());
  window.on('minimize',()=>homeAutomation?.stop());
  window.webContents.on('render-process-gone', () => { homeAutomation?.stop(); ++observationRendererGeneration; desktopObservation?.invalidate('RENDERER_CHANGED'); });
  window.webContents.on('destroyed', () => { ++observationRendererGeneration; desktopObservation?.invalidate('RENDERER_CHANGED'); });
  window.on('session-end', () => desktopObservation?.invalidate('SYSTEM_SESSION_CHANGED'));
  window.once('ready-to-show', () => window?.show());
  for (const channel of ['momo:home:command', 'momo:relay:command', channels.agent, channels.calendarAction, channels.snapshot, channels.settings, channels.importCredential, channels.removeCredential, channels.google, channels.inbox, channels.message, channels.calendar, channels.workspace, channels.startRun, channels.cancelRun, channels.task, 'momo:credentials:save','momo:conversation:clear','momo:task:receipt','momo:mail:command','momo:situation:command','momo:desktop-observation:command']) {
    ipcMain.handle(channel, (event, raw) => invokeOperation(channel, raw, !!window && isTrustedSender(event, window.webContents.id, development), async input => {
      if (channel === 'momo:home:command') return homeAutomation!.command(input);
      if (channel === 'momo:desktop-observation:command') return desktopObservation!.command(input, { rendererId: event.sender.id, generation: observationRendererGeneration });
      const disabled=(await storage!.get()).values.disabledModules;
      const requireModule=(id:ModuleId)=>{if(disabled.includes(id))throw new AppError('permission_denied','This workspace is disabled in Settings.');};
      if(channel==='momo:relay:command'){
        requireModule('relay');const command=input as import('../src/shared/relay').RelayCommand;
        if(command.action==='configureTransport')await relayTransport!.configure(command.config);
        else if(command.action==='secureSetup')await relayTransport!.secureSetup(command.purpose);
        else if(command.action==='syncTransport')await relayTransport!.sync();
        else if(command.action==='checkReadiness')await relayTransport!.checkReadiness();
        else if(command.action==='authorizeOutbound')await relayTransport!.authorizeOutbound();
        else if(command.action==='sendSms')await relayTransport!.send(command.id,command.approval);
        else if(command.action==='reconcileSms')await relayTransport!.reconcile(command.id);
        else {if(['cancel','complete','archive'].includes(command.action)&&'id' in command)relayTransport!.cancel(command.id);const result=await orchestration!.relayCommand(command),transport=await relayTransport!.snapshot();return {...result,connection:transport.config?'configured':'not-configured',lastSync:transport.lastSync,transport};}
        const result=await orchestration!.relaySnapshot(),transport=await relayTransport!.snapshot();return {...result,connection:transport.config?'configured':'not-configured',lastSync:transport.lastSync,transport};
      }
      if(channel==='momo:situation:command'){
        const command=situationCommandSchema.parse(input);
        const result=await situation.command(command);
        if(command.action!=='snapshot'&&command.action!=='search-places'&&!command.action.includes('flightaware'))await orchestration!.situationChanged();
        return result;
      }
      if(channel===channels.inbox||channel===channels.message)requireModule('inbox');
      if(channel===channels.calendar||channel===channels.task)requireModule('planner');
      if(channel===channels.calendarAction&&['prepare','review','approve'].includes((input as {action:string}).action))requireModule('planner');
      if(channel===channels.startRun)requireModule((input as {messageId?:string}).messageId?'inbox':'dashboard');
      if(channel===channels.agent&&(input as {action:string}).action==='start')requireModule(workflowModule((input as {event:{family:Parameters<typeof workflowModule>[0]}}).event.family));
      if(channel==='momo:mail:command'){const command=mailCommandSchema.parse(input);if(!['list','reconcile','deny','saveLocal'].includes(command.action))requireModule('inbox');const result=await mail.command(command);if(command.action==='thread'&&result.thread)void orchestration!.observeSchedulingThread(result.thread).catch(()=>undefined);if(!['list','thread'].includes(command.action))void orchestration!.schedulingChanged().catch(()=>undefined);return result;}
      if(channel===channels.agent){const command=agentCommandSchema.parse(input);
        if(command.action==='cancel')relayTransport?.cancel('id' in command?command.id:undefined);
        if(['config','policy','pause'].includes(command.action))relayTransport?.cancel();
        if (command.action === 'config' || command.action === 'policy') { ++observationContextGeneration; desktopObservation?.invalidate('CONTEXT_CHANGED'); }
        if(command.action==='exportLearning'){
          const value=await orchestration!.snapshot();const choice=await dialog.showSaveDialog(window!,{title:'Export learning preferences and feedback',defaultPath:'momo-learning.json',filters:[{name:'JSON',extensions:['json']}]});
          if(!choice.canceled&&choice.filePath)await writeFile(choice.filePath,JSON.stringify({version:1,exportedAt:new Date().toISOString(),feedback:value.state.feedback,candidates:value.state.candidates},null,2));return value;
        }
        if(command.action==='config'||command.action==='policy')assistant!.cancel();
        return orchestration!.command(command);
      }
      if (channel === channels.calendarAction) {const result=await calendarActions.command(calendarActionCommandSchema.parse(input));void orchestration!.schedulingChanged().catch(()=>undefined);return result;}
      if (channel === channels.settings) {
        const update = settingsUpdateSchema.parse(input);
        if(update.patch.disabledModules)relayTransport?.cancel();
        if (update.patch.desktopObservation?.enabled === true && !(await storage!.get()).values.desktopObservation?.enabled) {
          const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Cancel', 'Enable observation sessions'], defaultId: 0, cancelId: 0, message: 'Enable owner desktop observation sessions?', detail: 'Each session and target still requires your approval. This permission does not enable AI sharing, interaction or background observation.' });
          if (answer.response !== 1) throw new AppError('cancelled', 'Desktop observation permission was not enabled (OWNER_DECLINED).');
        }
        ++observationContextGeneration;
        desktopObservation?.invalidate(update.patch.desktopObservation?.enabled === false ? 'PERMISSION_DISABLED' : 'CONTEXT_CHANGED');
        for (const provider of ['deepseek','jev'] as const) if (update.patch[provider === 'deepseek' ? 'deepseekEnabled' : 'jevEnabled'] && await credentials.status(provider) !== 'configured') throw new AppError('unavailable', 'Save the ' + provider + ' key before enabling requests.');
        await storage!.update(update);await orchestration!.scopeChanged();inboxEnabled=!(await storage!.get()).values.disabledModules.includes('inbox');
        if (update.patch.disabledModules) { orchestration!.cancel(); assistant!.cancel(); }
        if (update.patch.deepseekEnabled === false || update.patch.jevEnabled === false || update.patch.timezone) assistant!.cancel();
      }
      if (channel === 'momo:conversation:clear') { const id=(input as {id:string}).id; await assistant!.clearConversation(id); return storage!.workspace(); }
      if (channel === 'momo:task:receipt') return storage!.taskReceipt((input as {id:string}).id);
      if (channel === channels.workspace) return storage!.workspace();
      if (channel === channels.startRun) {if(orchestration!.paused())throw new AppError('permission_denied','Global pause is on. Resume in Settings before making provider requests.');return assistant!.start(runRequestSchema.parse(input));}
      if (channel === channels.cancelRun) { assistant!.cancel((input as { id: string }).id); return storage!.workspace(); }
      if (channel === channels.task) { const value = await storage!.taskCommand(taskCommandSchema.parse(input)); window?.webContents.send(channels.workspaceChanged, value);void orchestration!.observeNative(taskEvents(value.tasks,(await google!.state()).activeAccountId,Date.now())).catch(()=>undefined);await orchestration!.sourceRefresh('task',(await google!.state()).activeAccountId,value.tasks.map(t=>({id:t.id,revision:hash(t)}))); return value; }
      if (channel === 'momo:credentials:save') {
        if (credentialsBusy) throw new AppError('unavailable', 'A credential operation is already open.');
        credentialsBusy = true;
        try { const value = saveCredentialSchema.parse(input); if(value.provider!=='openai'){orchestration!.cancel(); assistant!.cancel();} await credentials.save(value.provider, value.secret); }
        finally { credentialsBusy = false; }
      }
      if (channel === channels.inbox) {const value=await google!.inbox(inboxQuerySchema.parse(input));await orchestration!.sourceRefresh('email',value.accountId,value.messages.map(m=>({id:m.id,revision:hash({title:m.subject.slice(0,240),text:`From: ${m.from.slice(0,120)}; Date: ${m.receivedAt}; ${m.snippet.slice(0,600)}`})})));return value;}
      if (channel === channels.message) return google!.message(messageQuerySchema.parse(input));
      if (channel === channels.calendar) {const value=await google!.calendar(calendarQuerySchema.parse(input));await orchestration!.observeSchedulingCalendar(value);await orchestration!.sourceRefresh('calendar',value.accountId,value.events.map(e=>({id:e.id,revision:hash(e)})));return value;}
      if (channel === channels.google) {
        ++observationContextGeneration; desktopObservation?.invalidate('CONTEXT_CHANGED');
        const command = googleCommandSchema.parse(input);
        orchestration!.cancel();
        if (command.action === 'import') {
          if (credentialsBusy) throw new AppError('unavailable', 'A credential operation is already open.');
          credentialsBusy = true;
          try {
            if (!credentials.available()) throw new AppError('unavailable', 'Windows credential protection is unavailable.');
            const choice = await dialog.showOpenDialog(window!, { title: 'Import Google Desktop OAuth client', buttonLabel: 'Import client', properties: ['openFile'], filters: [{ name: 'Google OAuth client', extensions: ['json'] }] });
            if (choice.canceled || choice.filePaths.length !== 1) throw new AppError('cancelled', 'Google setup import cancelled.');
            const handle = await open(choice.filePaths[0], 'r');
            const bytes = Buffer.alloc(32769);
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > 32768) throw new AppError('invalid_input', 'Choose a Google Desktop OAuth JSON file smaller than 32 KB.');
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
              if (bytesRead > 32768) throw new AppError('invalid_input', 'The Google client file is too large.');
              let value: unknown;
              try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '')); }
              catch { throw new AppError('invalid_input', 'The selected file is not valid Google client JSON.'); }
              await google!.importClient(value);
            } finally { bytes.fill(0); await handle.close(); }
          } finally { credentialsBusy = false; }
        } else if(command.action==='connectMail'){assistant!.cancel();await google!.connect(command.accountId,command.capability);}
        else if (command.action === 'connectWrite') { assistant!.cancel(); await google!.connect(command.accountId); }
        else if (command.action === 'connect') await google!.connect();
        else if (command.action === 'cancel') google!.cancel();
        else if (command.action === 'select') { assistant!.cancel(); await google!.select(command.accountId); }
        else if (command.action === 'disconnect') {
          if (credentialsBusy) throw new AppError('unavailable', 'A credential operation is already open.');
          credentialsBusy = true;
          try {
            const answer = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Cancel', 'Disconnect'], defaultId: 0, cancelId: 0, message: 'Disconnect this Google account from MoMo?', detail: 'Deletes its local tokens and clears cached mail and events. To revoke MoMo at Google too, remove its access in your Google Account connections.' });
            if (answer.response !== 1) throw new AppError('cancelled', 'Disconnect cancelled.');
            assistant!.cancel(); await google!.disconnect(command.accountId);
          } finally { credentialsBusy = false; }
        }
      }
      if(channel===channels.google)await orchestration!.scopeChanged();
      if (channel === channels.importCredential || channel === channels.removeCredential) {
        if (credentialsBusy) throw new AppError('unavailable', 'A credential operation is already open.');
        credentialsBusy = true;
        try {
          const provider = providerSchema.parse((input as { provider: unknown }).provider);
          if (channel === channels.importCredential) {
            if (!credentials.available()) throw new AppError('unavailable', 'Windows credential protection is unavailable. No key was saved.');
            const choice = await dialog.showOpenDialog(window!, {
              title: 'Import ' + provider + ' key — remove the original text file after setup',
              buttonLabel: 'Store locally', properties: ['openFile'], filters: [{ name: 'Key text file', extensions: ['txt', 'key'] }],
            });
            if (choice.canceled || choice.filePaths.length !== 1) throw new AppError('cancelled', 'Key import cancelled.');
            if(provider!=='openai'){orchestration!.cancel(); assistant!.cancel();}
            await credentials.importFile(provider,choice.filePaths[0]);
          } else {
            const confirmation = await dialog.showMessageBox(window!, { type: 'question', buttons: ['Cancel', 'Remove key'], defaultId: 0, cancelId: 0, message: 'Remove the saved ' + provider + ' key?', detail: 'This removes the local protected copy. It does not revoke the provider key.' });
            if (confirmation.response !== 1) throw new AppError('cancelled', 'Key removal cancelled.');
            if(provider!=='openai'){orchestration!.cancel(); assistant!.cancel();} await credentials.remove(provider);
            if (provider === 'deepseek' || provider === 'jev') { const current = await storage!.get(); await storage!.update({ patch: { [provider === 'deepseek' ? 'deepseekEnabled' : 'jevEnabled']: false }, expectedRevision: current.revision }); }
          }
        } finally { credentialsBusy = false; }
      }
      const result = await snapshot();
      if (channel !== channels.snapshot && window && !window.isDestroyed()) window.webContents.send(channels.changed, result);
      return result;
    }));
  }
  await window.loadURL(development ? devOrigin : appOrigin + '/index.html');
  if(backgroundWorkAllowed)void orchestration?.resume('startup').catch(()=>{});
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  homeAutomation?.stop();
  relayTransport?.stop();
  desktopVoice?.stop();
  desktopObservation?.invalidate('SHUTDOWN');
  if (!storage || shuttingDown) return;
  event.preventDefault(); shuttingDown = true;
  if(scheduler)clearInterval(scheduler);
  google?.close();
  void (async () => { await assistant?.close(); await desktopVoice?.idle(); await orchestration?.close(); await storage!.close(); })().catch(() => undefined).finally(() => app.quit());
});
