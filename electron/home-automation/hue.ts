import net from 'node:net';
import https from 'node:https';
import { localAddressSchema, type HueDiagnostic } from '../../src/shared/home-automation';

/** One owner-configured host, no redirects, no pairing, no certificate override. */
export async function checkHue(address:string,signal:AbortSignal):Promise<HueDiagnostic> {
  localAddressSchema.parse(address);
  const base:HueDiagnostic={checkedAt:new Date().toISOString(),network:'unreachable',tls:'not-checked',identity:'unverified',pairing:'not-paired',resourceAccess:'not-authorized',note:''};
  const tcp=await new Promise<string|null>(resolve=>{
    const socket=net.createConnection({host:address,port:443,signal});
    const timer=setTimeout(()=>finish('TCP 443 timed out after 3 seconds.'),3000);
    const finish=(error:string|null)=>{clearTimeout(timer);socket.destroy();resolve(error);};
    socket.once('connect',()=>finish(null));socket.once('error',error=>finish(`TCP 443 failed (${(error as NodeJS.ErrnoException).code??'unavailable'}).`));
  });
  if(tcp)return {...base,note:tcp+' Routing and isolation have not been established.'};
  base.network='reachable';
  return new Promise(resolve=>{
    let complete=false;
    // Public Hue getting-started guide documents this harmless unauthenticated read.
    const request=https.get({hostname:address,port:443,path:'/api/newdeveloper',rejectUnauthorized:true,agent:false,signal},response=>{
      let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>8192)finish({...base,tls:'trusted',note:'HTTPS answered; response exceeded the diagnostic limit. Bridge identity remains unverified.'});});
      response.on('end',()=>finish({...base,tls:'trusted',note:`HTTPS answered (HTTP ${response.statusCode}). No bridge identity has been pinned; pairing and resource access remain unauthorized.`}));
      response.on('error',()=>finish({...base,tls:'unverified',note:'TCP 443 answered; the HTTPS response was incomplete. Bridge identity unverified.'}));
    });
    const timer=setTimeout(()=>finish({...base,tls:'unverified',note:'TCP 443 answered; trusted HTTPS did not complete within 3 seconds. Bridge identity unverified.'}),3000);
    const finish=(result:HueDiagnostic)=>{if(complete)return;complete=true;clearTimeout(timer);request.destroy();resolve(result);};
    request.on('error',error=>finish({...base,tls:'unverified',note:`TCP 443 answered; HTTPS trust/transport check failed (${(error as NodeJS.ErrnoException).code??'unavailable'}). Bridge identity unverified; certificate validation was preserved.`}));
  });
}
