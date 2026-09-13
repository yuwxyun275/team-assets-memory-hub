import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QualityOutbox } from "../quality-outbox.js";
import { observeQualityWindow, qualityEvents, qualityScene } from "../quality-observer.js";

describe("quality evidence transport", () => {
  it('captures bounded pre-retrieval evidence without changing the client history', () => {
    const messages: any = Array.from({ length: 18 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', blocks: [{ type: 'text', content: `event ${i} ` + 'x'.repeat(7000) }] }));
    const original = JSON.stringify(messages);
    const scene = qualityScene({ messages, task: 'Redis outage repair', query: 'CacheUnavailable fallback', turn: 2, requestId: 'request', activePaths: ['service.py'], errors: ['timeout'] });
    expect(scene.events.length).toBeLessThanOrEqual(12);
    expect(scene.events.reduce((n, e) => n + e.content.length, 0)).toBeLessThanOrEqual(16000);
    expect(scene.truncated).toBe(true); expect(JSON.stringify(messages)).toBe(original);
    expect(scene.events[0].content).toBe('Redis outage repair');
    expect(scene.events.some(e => e.content.includes('event 17'))).toBe(true);
  });
  it('retains exhausted deliveries and supports explicit encrypted operator recovery',async()=>{
    vi.useFakeTimers(); const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const directory=mkdtempSync(join(tmpdir(),'quality-outbox-dead-')),deliver=vi.fn(async():Promise<void>=>{throw new Error('offline');});
      const box=new QualityOutbox(directory,Buffer.alloc(32,4),deliver);
      box.enqueue({space:'s',userKey:'private-key',action:'expose',data:{asset_id:'a'}});
      for(let i=0;i<13;i++){await box.tick();vi.advanceTimersByTime(300001);}
      expect(box.deadLetters()).toHaveLength(1); const name=box.deadLetters()[0];
      expect(readFileSync(join(directory,name)).includes(Buffer.from('private-key'))).toBe(false);
      expect(()=>box.retryDeadLetter('../bad','retry')).toThrow('invalid_dead_letter_retry');
      deliver.mockImplementation(async()=>{});box.retryDeadLetter(name,'Operator restored service and inspected the failed request');await box.tick();
      expect(box.deadLetters()).toHaveLength(0);expect(readdirSync(directory)).toEqual([name+'.replayed']);
    } finally {vi.useRealTimers();warn.mockRestore();}
  });
  it("excludes system instructions and credentials and keeps stable exact event identities", () => {
    const messages: any = [{role:'system',blocks:[{type:'text',content:'private system'}]}, {role:'user',blocks:[{type:'text',content:'请检查租户隔离。'}]}, {role:'tool',blocks:[{type:'tool_result',content:'9 passed'}]}];
    const events=qualityEvents(messages);
    expect(events).toHaveLength(2); expect(events[1].role).toBe('tool_result');
    expect(qualityEvents(messages)).toEqual(events);
    expect(qualityEvents([{role:'user',blocks:[{type:'text',content:'sk-1234567890abcdefghijklmno'}]}] as any)).toEqual([]);
  });
  it("does not send the pre-injection baseline or already-observed events again", async () => {
    const quality=vi.fn(async (action:string) => action==='open-exposures'?{items:[{key:'e',baseline_event_ids:['old'],event_ids:['seen']}]}:{});
    await observeQualityWindow({quality} as any,'team','task','session',[{id:'old',role:'user',content:'before'},{id:'seen',role:'assistant',content:'seen'},{id:'new',role:'tool_result',content:'result'}]);
    expect((quality.mock.calls[1] as any)[1].observation.events.map((x:any)=>x.id)).toEqual(['new']);
  });
  it("persists encrypted evidence, coalesces retries and replays after a process restart", async () => {
    const directory=mkdtempSync(join(tmpdir(),'quality-outbox-')), key=Buffer.alloc(32,7);
    const deliver=vi.fn(async()=>{});
    const first=new QualityOutbox(directory,key,deliver);
    const payload:any={space:'default',userKey:'business-key-not-logged',action:'window',data:{content:'原始对话不脱敏'}};
    first.enqueue(payload); first.enqueue(payload);
    const files=readdirSync(directory);expect(files).toHaveLength(1);
    expect(readFileSync(join(directory,files[0])).includes(Buffer.from('business-key'))).toBe(false);
    const restarted=new QualityOutbox(directory,key,deliver);await restarted.tick();
    expect(deliver).toHaveBeenCalledWith(payload);expect(readdirSync(directory)).toHaveLength(0);
  });
  it("retains an unacknowledged delivery instead of inventing a success", async () => {
    const directory=mkdtempSync(join(tmpdir(),'quality-outbox-fail-'));
    const box=new QualityOutbox(directory,Buffer.alloc(32,2),async()=>{throw new Error('offline');});
    box.enqueue({space:'s',userKey:'k',action:'expose',data:{asset_id:'a'}});await box.tick();
    expect(readdirSync(directory).filter(x=>x.endsWith('.q'))).toHaveLength(1);
  });
  it('quarantines corrupted ciphertext and continues with later valid events', async () => {
    const directory=mkdtempSync(join(tmpdir(),'quality-outbox-corrupt-'));
    writeFileSync(join(directory,'000-corrupt.q'),Buffer.from('broken ciphertext'),{mode:0o600});
    const deliver=vi.fn(async()=>{}), warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try {
      const box=new QualityOutbox(directory,Buffer.alloc(32,2),deliver);
      box.enqueue({space:'s',userKey:'k',action:'expose',data:{asset_id:'a'}});
      await box.tick(); expect(deliver).not.toHaveBeenCalled();
      expect(readdirSync(directory)).toContain('000-corrupt.q.quarantined');
      await box.tick(); expect(deliver).toHaveBeenCalledOnce();
      expect(readdirSync(directory)).toEqual(['000-corrupt.q.quarantined']);
    } finally { warn.mockRestore(); }
  });
});
