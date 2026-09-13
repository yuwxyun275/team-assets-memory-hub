import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { observeQualityWindow } from "./quality-observer.js";

type Payload = { space: string; userKey: string; action: "expose" | "window"; data: any };
type CoreLink = Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">;
/** Single Proxy writer, encrypted disk outbox. Authentication keys never enter evaluation payloads. */
export class QualityOutbox {
  private busy = false;
  private sequence = 0;
  constructor(private directory: string, private key: Buffer, private deliver: (p: Payload) => Promise<void>) {
    if (key.length !== 32) throw new Error("QUALITY_OUTBOX_KEY must contain 32 bytes");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private files() { return readdirSync(this.directory).filter(f => f.endsWith(".q")).sort(); }
  deadLetters() { return readdirSync(this.directory).filter(f => f.endsWith('.dead')).sort(); }
  /** Operator-only explicit recovery; keeps the original encrypted record. */
  retryDeadLetter(name: string, note: string) {
    if (!/^\d+-[a-f0-9]{64}\.q\.dead$/.test(name) || !note.trim() || note.length > 2000) throw new Error('invalid_dead_letter_retry');
    const path=join(this.directory,name), data=readFileSync(path);
    const decipher=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));
    const record=JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString());
    const target=path.slice(0,-5); if(existsSync(target)) throw new Error('dead_letter_already_pending');
    this.write(target,{...record,original_created:record.original_created??record.created,created:Date.now(),attempts:0,due:0,
      operator_retry:{at:Date.now(),note}});
    renameSync(path,path+'.replayed');
  }
  private write(path: string, record: any) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
    const fd = openSync(path + ".tmp", "w", 0o600);
    try { writeFileSync(fd, Buffer.concat([iv, cipher.getAuthTag(), ciphertext])); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(path + ".tmp", path);
  }
  enqueue(payload: Payload) {
    if (Buffer.byteLength(JSON.stringify(payload)) > 250_000) throw new Error("quality_outbox_payload_limit");
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    // Pending duplicate deliveries coalesce. Core also deduplicates already-acknowledged events.
    if (this.files().some(f => f.includes(digest))) return;
    if (readdirSync(this.directory).filter(f => f.endsWith('.q') || f.endsWith('.quarantined') || f.endsWith('.dead')).length >= 1000) throw new Error("quality_outbox_capacity");
    this.sequence = Math.max(Date.now(), this.sequence + 1);
    this.write(join(this.directory, `${this.sequence}-${digest}.q`), { payload, created: Date.now(), attempts: 0, due: 0 });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const file = this.files()[0]; if (!file) return;
      const path = join(this.directory, file), data = readFileSync(path);
      let r: { payload: Payload; created: number; attempts: number; due: number };
      try {
        const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
        decipher.setAuthTag(data.subarray(12, 28));
        r = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
        if (!r.payload || !Number.isFinite(r.created) || !Number.isFinite(r.attempts) || !Number.isFinite(r.due)) throw new Error('invalid_record');
      } catch {
        // Preserve the encrypted original for operator recovery. One corrupt item must not block every later event.
        renameSync(path, path + '.quarantined');
        console.warn('[quality] encrypted outbox item quarantined; check integrity/key, no usage credit inferred');
        return;
      }
      if (Date.now() - r.created > 86400000 || r.attempts >= 12) {
        renameSync(path, path + '.dead');
        console.warn("[quality] outbox delivery exhausted; encrypted dead letter retained for operator recovery, no usage credit inferred"); return;
      }
      if (r.due > Date.now()) return;
      try { await this.deliver(r.payload); if (existsSync(path)) unlinkSync(path); }
      catch { this.write(path, { ...r, attempts: r.attempts + 1, due: Date.now() + Math.min(300000, 1000 * 2 ** r.attempts) }); }
    } finally { this.busy = false; }
  }
}

let outbox: QualityOutbox | undefined;
export function startQualityOutbox(core?: CoreLink, runWorker = true) {
  const directory = process.env.QUALITY_OUTBOX_DIR, secret = process.env.QUALITY_OUTBOX_KEY;
  if (!directory || !secret || !core) return;
  if (!/^[a-fA-F0-9]{64}$/.test(secret)) throw new Error("invalid QUALITY_OUTBOX_KEY");
  outbox = new QualityOutbox(directory, Buffer.from(secret, "hex"), async p => {
    const client = getMetadataClient(core, p.space, p.userKey);
    if (p.action === "expose") await client.quality("expose", p.data);
    else await observeQualityWindow(client, p.data.team, p.data.task, p.data.session, p.data.events);
  });
  if (runWorker) setInterval(() => { void outbox?.tick().catch(() => console.warn("[quality] outbox unavailable; operator inspection required")); }, 1000).unref();
}
export async function deliverQuality(core: CoreLink, space: string, userKey: string, action: Payload["action"], data: any) {
  if (outbox) { outbox.enqueue({ space, userKey, action, data }); return; }
  const client = getMetadataClient(core, space, userKey);
  if (action === "expose") await client.quality("expose", data);
  else await observeQualityWindow(client, data.team, data.task, data.session, data.events);
}
