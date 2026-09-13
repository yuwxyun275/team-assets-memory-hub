/** Run inside the configured Proxy container; never prints decrypted evidence or credentials. */
import {QualityOutbox} from '../injection/injectors/quality-outbox.js';
const directory=process.env.QUALITY_OUTBOX_DIR,key=process.env.QUALITY_OUTBOX_KEY;
if(!directory||!key||!/^[a-f0-9]{64}$/i.test(key))throw new Error('configured encrypted outbox is required');
const box=new QualityOutbox(directory,Buffer.from(key,'hex'),async()=>{throw new Error('only the running Proxy worker may deliver');});
const [mode,id,note]=process.argv.slice(2);
if(mode==='list')console.log(JSON.stringify({dead_letters:box.deadLetters(),instruction:'Repair the cause, inspect the task receipt, then explicitly retry one ID. This command never forwards evidence.'}));
else if(mode==='retry'&&id&&note){box.retryDeadLetter(id,note);console.log(JSON.stringify({requeued:id,original_encrypted_record_retained:true}));}
else throw new Error('Usage: recover-quality-outbox.ts list | retry <exact-dead-letter-id> <operator-note>');
