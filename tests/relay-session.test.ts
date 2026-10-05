// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { describe, expect, it } from 'vitest';
import { relaySessionPolicy } from '../electron/relay/session';
describe('Relay deployment session isolation',()=>{
 it('allows inbound setup without enabling a saved background schedule or outbound action',()=>{
  expect(relaySessionPolicy(['--relay-setup-only'])).toEqual({backgroundWorkAllowed:false,relayNetworkAllowed:true,relayOutboundAllowed:false});
  expect(relaySessionPolicy(['--relay-setup-only','--no-background-work'])).toEqual({backgroundWorkAllowed:false,relayNetworkAllowed:true,relayOutboundAllowed:false});
 });
 it('keeps offline review authoritative over the setup flag',()=>{
  expect(relaySessionPolicy(['--relay-setup-only','--offline-review'])).toEqual({backgroundWorkAllowed:false,relayNetworkAllowed:false,relayOutboundAllowed:false});
 });
 it('preserves ordinary and background-disabled sessions',()=>{
  expect(relaySessionPolicy([])).toEqual({backgroundWorkAllowed:true,relayNetworkAllowed:true,relayOutboundAllowed:true});
  expect(relaySessionPolicy(['--no-background-work'])).toEqual({backgroundWorkAllowed:false,relayNetworkAllowed:false,relayOutboundAllowed:false});
 });
});
