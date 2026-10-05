// Run only through the cloud account's authenticated administrative console.
// Revokes the paired device without touching queued events or printing identities/secrets.
import { DatabaseSync } from 'node:sqlite';
if(process.argv[2]!=='unpair')throw Error('Usage: node admin.mjs unpair');
const db=new DatabaseSync(process.env.DATABASE_PATH??'/data/relay.sqlite');
db.exec("BEGIN IMMEDIATE; DELETE FROM state WHERE id='device'; DELETE FROM nonces; COMMIT;");
db.close();console.log('Desktop pairing revoked. Configure a new short-lived pairing token before re-pairing.');
