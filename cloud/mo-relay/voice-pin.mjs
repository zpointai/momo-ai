import { pinVerifier } from './voice.mjs';
// Invoked only by the secure console setup. Never accepts secrets in argv or prints raw input.
let input='';
try {
 for await(const chunk of process.stdin){input+=chunk;if(input.length>100)throw Error();}
 const pin=input.trim();process.stdout.write(pinVerifier(pin));input='';
}catch{input='';process.stderr.write('Voice PIN must contain 6 to 12 digits.');process.exitCode=1;}
