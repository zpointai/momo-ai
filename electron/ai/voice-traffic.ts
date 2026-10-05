/** No provider fetch or payload is permitted until the account's Voice entitlement is established. */
export function voiceTrafficLimitation(prompt:string):string|null {
 if(!/\btraffic\b|\bcommute\b|\b(?:drive|driving) (?:home|to work)\b|\b(?:get|getting) home\b|\bshould I leave earlier\b|\bdelay on my route\b|\bwhat.*on the way to\b/i.test(prompt))return null;
 return 'Live traffic answers over the phone are not enabled because the provider permission for spoken delivery is not yet established. You can check your saved route in Situation View. I have not looked up traffic or inferred a journey time.';
}
