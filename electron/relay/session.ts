/** Session-only setup never changes saved schedules or action authority. */
export function relaySessionPolicy(argv: readonly string[]) {
 const setupOnly=argv.includes('--relay-setup-only');
 const backgroundWorkAllowed=!setupOnly&&!argv.includes('--no-background-work');
 const online=!argv.includes('--offline-review');
 return {backgroundWorkAllowed,relayNetworkAllowed:online&&(setupOnly||backgroundWorkAllowed),relayOutboundAllowed:online&&!setupOnly&&backgroundWorkAllowed};
}
