import { randomUUID } from 'node:crypto';
import { homeCommandSchema, emptyHome, type HomeStored, type HomeSnapshot, type HomeDevice, type HomeInterface, type HomeReceipt, type LightOperation, type HueDiagnostic } from '../../src/shared/home-automation';
import { AppError } from '../errors';
import { GoveeLan, GoveeIdentityError, listHomeInterfaces, type HomeLan, type HomeLanSession } from './govee';
import { checkHue } from './hue';
import type { HomeStore } from './store';

export type HomeConfirm=(title:string,message:string,detail:string)=>Promise<boolean>;
export interface HomeAuthority { enabled():Promise<boolean>; visible():boolean; confirm:HomeConfirm }
export class HomeAutomationService {
  private state:HomeStored=emptyHome();
  private grant:HomeSnapshot['grant']=null;
  private hue:HueDiagnostic|null=null;
  private diagnostic='Discovery has not run in this session.';
  private selected:string|null=null;
  private busy=false;
  private epoch=0;
  private abort:AbortController|null=null;
  private loadPromise:Promise<void>|null=null;
  private saveTail=Promise.resolve();
  constructor(private store:HomeStore,private authority:HomeAuthority,private lan:HomeLan=new GoveeLan(),private interfaces= listHomeInterfaces,private now=Date.now,private hueCheck=checkHue){}
  private load() {return this.loadPromise??=this.store.load().then(state=>{this.state=state;for(const d of this.state.devices)d.availability='unavailable';for(const r of this.state.receipts)if(r.reconciliation?.stage==='checking'){r.reconciliation.stage='state-unknown';r.reconciliation.reason='settle_timeout';r.reconciliation.finishedAt=this.stamp();r.note='Previous state check was interrupted. No command or check is replayed on restart.';}});}
  private save() {const copy=structuredClone(this.state);const next=this.saveTail.catch(()=>undefined).then(()=>this.store.save(copy));this.saveTail=next;return next;}
  private stamp(){return new Date(this.now()).toISOString();}
  private invalidate(revoke=true){++this.epoch;this.abort?.abort();if(revoke)this.grant=null;}
  stop(){this.selected=null;this.invalidate();}
  async snapshot():Promise<HomeSnapshot> {
    await this.load();
    const interfaces=this.interfaces();
    if(this.grant?.expiresAt&&Date.parse(this.grant.expiresAt)<=this.now())this.invalidate();
    if(this.state.config.interfaceId&&!interfaces.some(i=>i.id===this.state.config.interfaceId))this.invalidate();
    const d=this.state.devices.find(d=>d.identity===this.selected),permission=this.state.permission,epoch=this.epoch;
    if(!this.grant&&d&&permission&&this.remembered(d)&&this.usable(d)&&this.now()-Date.parse(d.seenAt)<30_000&&d.state&&this.now()-Date.parse(d.state.at)<30_000&&interfaces.some(i=>i.id===d.interfaceId)&&this.state.config.interfaceId===d.interfaceId&&await this.authority.enabled()&&this.authority.visible()&&epoch===this.epoch&&this.selected===d.identity&&this.remembered(d)&&!this.grant){
      this.grant={id:randomUUID(),identity:d.identity,expiresAt:null,power:permission.power&&d.state.power!==null,brightness:permission.brightness&&d.state.brightness!==null};
    }
    return structuredClone({...this.state,devices:this.state.devices.map(d=>({...d,availability:d.availability==='observed'&&this.now()-Date.parse(d.seenAt)>=30_000?'unavailable':d.availability})),interfaces,grant:this.grant,hue:this.hue,busy:this.busy,diagnostic:this.diagnostic,checkedAt:this.stamp()});
  }
  private iface():HomeInterface {
    const match=this.interfaces().find(i=>i.id===this.state.config.interfaceId);
    if(!match)throw new AppError('unavailable','Choose an available local interface in Home Automation settings.');
    return match;
  }
  private assertCurrent(epoch:number){if(epoch!==this.epoch||this.abort?.signal.aborted)throw new AppError('permission_denied','The operation was cancelled or its permission changed.');}
  private async assertOwner(epoch:number){this.assertCurrent(epoch);if(!await this.authority.enabled()||!this.authority.visible())throw new AppError('permission_denied','Open Home Automation in the foreground to continue.');this.assertCurrent(epoch);}
  private device(identity:string) {const d=this.state.devices.find(d=>d.identity===identity);if(!d)throw new AppError('invalid_input','Discover and select this device first.');return d;}
  private mapped(d:HomeDevice) {const m=this.state.mapping;return !!m&&m.identity===d.identity&&m.model===d.model&&m.endpoint===d.endpoint&&m.interfaceId===d.interfaceId;}
  private remembered(d:HomeDevice) {const p=this.state.permission;return !!p&&this.mapped(d)&&p.identity===d.identity&&p.model===d.model&&p.endpoint===d.endpoint&&p.interfaceId===d.interfaceId;}
  private usable(d:HomeDevice){return d.category==='light'&&d.capability==='documented-light'&&d.availability==='observed';}
  private reconcile(found:HomeDevice[]) {
    for(const old of this.state.devices)old.availability='unavailable';
    for(const next of found){const old=this.state.devices.find(d=>d.identity===next.identity);if(old){next.state??=old.state;Object.assign(old,next);}else if(this.state.devices.length<128)this.state.devices.push(next);}
    const mapped=this.state.devices.find(d=>d.identity===this.state.mapping?.identity);
    if(mapped&&this.state.permission&&(!this.remembered(mapped)||mapped.availability==='ambiguous'))this.state.permission=null;
    if(this.grant&&(!mapped||!this.mapped(mapped)||!this.usable(mapped)))this.grant=null;
  }
  private async withLan<T>(action:(session:HomeLanSession,epoch:number)=>Promise<T>):Promise<T> {
    const epoch=this.epoch;
    this.abort=new AbortController();
    const iface=this.iface(),session=await this.lan.open(iface,this.abort.signal);
    try{return await action(session,epoch);}finally{session.close();this.abort=null;}
  }
  async command(raw:unknown):Promise<HomeSnapshot> {
    const c=homeCommandSchema.parse(raw);await this.load();
    if(c.action==='snapshot')return this.snapshot();
    if(c.action==='cancel'){this.invalidate(false);return this.snapshot();}
    if(c.action==='revoke'){this.invalidate();this.state.permission=null;await this.save();return this.snapshot();}
    if(c.action==='select'){if(this.selected!==c.identity){this.selected=c.identity;this.invalidate();}return this.snapshot();}
    if(!await this.authority.enabled())throw new AppError('permission_denied','Home Automation is disabled in Settings.');
    if(!this.authority.visible())throw new AppError('permission_denied','Open MoMo in the foreground to continue.');
    if(this.busy)throw new AppError('conflict','A local operation is already running. Cancel it or wait. Commands are never queued.');
    this.busy=true;
    try {
      if(c.action==='configure'){
        if(c.config.interfaceId&&!this.interfaces().some(i=>i.id===c.config.interfaceId))throw new AppError('invalid_input','That local interface is no longer available.');
        this.invalidate();if(this.state.config.interfaceId!==c.config.interfaceId)this.state.permission=null;this.state.config=c.config;this.hue=null;for(const d of this.state.devices)d.availability='unavailable';await this.save();
      }else if(c.action==='discover'){
        await this.withLan(async(session,epoch)=>{
          const found=await session.scan();this.assertCurrent(epoch);
          // Two 1.6s probe windows plus at most 24 × 450ms status windows: under 15s.
          for(const d of found.slice(0,24)){if(d.availability!=='ambiguous'){try{d.state=await session.state(d);if(!d.state)d.availability='unavailable';}catch(error){if(!(error instanceof GoveeIdentityError))throw error;d.availability='ambiguous';}}this.assertCurrent(epoch);}
          for(const d of found.slice(24))if(d.availability!=='ambiguous')d.availability='unavailable';
          this.reconcile(found);const mapped=found.find(d=>d.identity===this.state.mapping?.identity);
          this.diagnostic=`${found.length} local device(s); ${found.filter(d=>d.state&&d.availability==='observed').length} fresh state response(s). ${this.state.mapping&&!mapped?'Known mapped device not currently observed. ':''}${found.length?'LAN identities remain unauthenticated.':'Discovery timeout: no valid response in the bounded windows.'}`;
          await this.save();
        });
      }else if(c.action==='map'){
        const d=this.device(c.identity);if(!this.usable(d)||this.now()-Date.parse(d.seenAt)>30_000)throw new AppError('permission_denied','Refresh discovery. Mapping requires a recently observed, documented light.');
        const epoch=this.epoch,copy=structuredClone(d);
        const accepted=await this.authority.confirm('Confirm pilot light','Bind this exact light to '+c.alias+'?',`Match this identity and model with the vendor app or the physical device. Do not infer identity from the IP address or model alone.\n\nIdentity: ${d.identity}\nModel: ${d.model}\nEndpoint: ${d.endpoint}\n\nOnly this single pilot can receive a later power/brightness grant. No command is sent now.`);
        await this.assertOwner(epoch);
        if(accepted){this.invalidate();this.state.permission=null;this.state.mapping={identity:copy.identity,model:copy.model,endpoint:copy.endpoint,interfaceId:copy.interfaceId,alias:c.alias,confirmedAt:this.stamp()};await this.save();}
      }else if(c.action==='grant'){
        const d=this.device(c.identity);if(!this.mapped(d)||!this.usable(d)||this.selected!==d.identity||!d.state||this.now()-Date.parse(d.state.at)>30_000)throw new AppError('permission_denied','Select and refresh the confirmed pilot before granting control.');
        const epoch=this.epoch;
        const duration=c.remember?'Remember permission for this exact identity, model, endpoint and interface until you revoke it. Closing MoMo, changing views and restarting do not erase this permission. Fresh discovery and foreground selection are still required. A changed device or network binding requires a new review.':'This grant expires after 30 minutes, selection/view closure, network change or restart.';
        const accepted=await this.authority.confirm('Allow direct light controls',(c.remember?'Remember power and brightness permission for ':'Allow power and brightness for ')+this.state.mapping!.alias+'?',`Identity: ${d.identity}\nModel: ${d.model}\n\nOnly documented controls with observed state are allowed. ${duration} The first physical operation has its own confirmation. Mo, Voice, background and group actions are excluded.`);
        await this.assertOwner(epoch);
        if(accepted){
          const power=d.state.power!==null,brightness=d.state.brightness!==null;
          if(c.remember){this.state.permission={identity:d.identity,model:d.model,endpoint:d.endpoint,interfaceId:d.interfaceId,power,brightness,confirmedAt:this.stamp()};await this.save();}
          this.grant={id:randomUUID(),identity:d.identity,expiresAt:c.remember?null:new Date(this.now()+30*60_000).toISOString(),power,brightness};
        }
      }else if(c.action==='control'){
        await this.control(c.identity,c.grantId,c.operation);
      }else if(c.action==='physical-result'){
        const receipt=this.state.receipts.find(r=>r.id===c.receiptId);
        if(!receipt?.sent)throw new AppError('invalid_input','There is no sent command to confirm.');
        const epoch=this.epoch;
        if(await this.authority.confirm('Record physical result',c.confirmed?'Did the selected light visibly match this operation?':'Record that the physical result was not observed?',`${receipt.alias}\nIdentity: ${receipt.identity}\nOperation: ${receipt.operation.kind} = ${receipt.operation.value}\nSent: ${receipt.at}\n\nThis records your observation; it sends no device command.`)){
          await this.assertOwner(epoch);receipt.physical=c.confirmed?'confirmed':'not-observed';await this.save();
        }
      }else if(c.action==='hue-check'){
        if(!this.state.config.hueAddress)throw new AppError('invalid_input','Enter the bridge address in Home Automation settings.');
        const epoch=this.epoch;this.abort=new AbortController();
        try{const result=await this.hueCheck(this.state.config.hueAddress,this.abort.signal);this.assertCurrent(epoch);this.hue=result;}finally{this.abort=null;}
      }
    }catch(error){
      if(error instanceof GoveeIdentityError){this.grant=null;this.state.permission=null;await this.save();}
      if(c.action==='discover'){for(const d of this.state.devices)d.availability='unavailable';this.grant=null;this.diagnostic=error instanceof AppError?error.message:'Local discovery failed. No control commands were sent.';}
      throw error;
    }finally{this.busy=false;}
    return this.snapshot();
  }
  private validateControl(identity:string,grantId:string,operation:LightOperation) {
    const d=this.device(identity),grant=this.grant;
    if(!grant||grant.id!==grantId||grant.identity!==identity||(grant.expiresAt?Date.parse(grant.expiresAt)<=this.now():!this.remembered(d))||this.selected!==identity||!this.mapped(d)||!this.usable(d)||!grant[operation.kind]||this.iface().id!==d.interfaceId)
      throw new AppError('permission_denied','This exact light has no current grant for the requested operation. Refresh and review its permission.');
    return d;
  }
  private async control(identity:string,grantId:string,operation:LightOperation) {
    this.validateControl(identity,grantId,operation);
    const previous=this.state.receipts.find(r=>r.identity===identity&&r.sent);
    if(previous&&previous.physical==='unconfirmed')throw new AppError('permission_denied','Record the previous physical result before another command.');
    await this.withLan(async(session,epoch)=>{
      const found=await session.scan();this.assertCurrent(epoch);this.reconcile(found);
      const d=this.validateControl(identity,grantId,operation);
      const starting=await session.state(d);await this.assertOwner(epoch);
      if(!starting||starting[operation.kind]===null){d.availability='unavailable';this.grant=null;throw new AppError('unavailable','The current starting state is unknown. Nothing was sent.');}
      d.state=starting;
      if(!previous){
        const accepted=await this.authority.confirm('First physical light test',`${this.state.mapping!.alias}: set ${operation.kind} to ${operation.value}?`,`Identity: ${identity}\nModel: ${d.model}\nStarting power: ${d.state.power}\nStarting brightness: ${d.state.brightness}%\n\nOne operation only. No automatic restoration. A prior animation/effect cannot be restored from the available state. Other apps may change this light.`);
        await this.assertOwner(epoch);if(!accepted)return;
        // Requery after the dialog: never restore or overwrite from an older cached baseline.
        const refreshed=await session.state(d);if(!refreshed||refreshed[operation.kind]===null){d.availability='unavailable';this.grant=null;throw new AppError('unavailable','Starting state became unavailable. Nothing was sent.');}d.state=refreshed;
      }
      const receipt:HomeReceipt={id:randomUUID(),identity,alias:this.state.mapping!.alias,at:this.stamp(),operation,sent:false,before:structuredClone(d.state),after:null,outcome:'attempted',physical:'unconfirmed',note:'Attempt recorded before sending.'};
      this.state.receipts.unshift(receipt);this.state.receipts=this.state.receipts.slice(0,40);await this.save();
      try {
        await this.assertOwner(epoch);this.validateControl(identity,grantId,operation);
        await session.send(d,operation);receipt.sent=true;receipt.outcome='sent-unconfirmed';receipt.note='UDP send completed. Device execution and physical result are not proven.';
        receipt.reconciliation={sentAt:this.stamp(),finishedAt:null,stage:'checking',reason:'send_completed_state_pending',observations:[]};await this.save();
        await this.reconcileCommand(session,epoch,d,receipt);
      }catch(error){
        receipt.outcome=receipt.sent?'sent-unconfirmed':epoch!==this.epoch?'cancelled':'failed';receipt.note=receipt.sent?'Command sent; outcome unavailable. Do not retry automatically.':'No completed send was confirmed.';
        if(receipt.reconciliation){const invalid=error instanceof GoveeIdentityError;receipt.reconciliation.stage=invalid?'identity-invalidated':epoch!==this.epoch?'cancelled':'state-unknown';receipt.reconciliation.reason=invalid?'identity_mismatch':epoch!==this.epoch?'cancelled':'settle_timeout';receipt.reconciliation.finishedAt=this.stamp();d.availability=invalid?'ambiguous':'unavailable';this.grant=null;if(invalid)this.state.permission=null;}
        if(!receipt.sent)throw error;
      }
      finally{await this.save();}
    });
  }
  private async reconcileCommand(session:HomeLanSession,epoch:number,d:HomeDevice,receipt:HomeReceipt) {
    const check=receipt.reconciliation!;
    const finish=(stage:typeof check.stage,reason:typeof check.reason)=>{check.stage=stage;check.reason=reason;check.finishedAt=this.stamp();};
    const read=async()=>{const state=await session.state(d);await this.assertOwner(epoch);if(this.iface().id!==d.interfaceId||!this.mapped(d)||d.availability==='ambiguous')throw new GoveeIdentityError();if(state){check.observations.push(state);receipt.after=state;d.state=state;d.seenAt=state.at;d.availability='observed';}return state;};
    let state=await read();
    // A differing immediate reply is evidence, not final physical failure. Revalidate identity
    // through the ordinary bounded scan before ONE later status query. Never resend the write.
    if(!state||state[receipt.operation.kind]!==receipt.operation.value){
      await this.save();const found=await session.scan();await this.assertOwner(epoch);this.reconcile(found);
      const current=found.find(next=>next.identity===d.identity);
      if(found.some(next=>next.endpoint===d.endpoint&&next.identity!==d.identity))throw new GoveeIdentityError();
      if(current&&(!this.mapped(d)||d.availability==='ambiguous'))throw new GoveeIdentityError();
      if(!current){this.grant=null;finish('state-unknown','mapped_device_not_seen');receipt.note='Sent; mapped device not observed in the bounded recheck. Earlier evidence retained. No retry.';return;}
      state=await read();
    }
    if(!state||state[receipt.operation.kind]===null){d.availability='unavailable';this.grant=null;finish('state-unknown','status_timeout');receipt.note='Sent; latest state query timed out or omitted the requested field. Earlier evidence retained. No retry.';return;}
    const matches=state[receipt.operation.kind]===receipt.operation.value;
    receipt.outcome=matches?'observed-match':'observed-different';finish(matches?'observed-match':'observed-different',matches?'observed_match':'observed_different');
    receipt.note='Bounded state check finished. Observations do not prove command causation or physical success; other controllers may change the device.';
  }
}
