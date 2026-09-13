import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aggregate, assetPayload, rawReplay, parseUsage } from './fixture.ts';
const fixture={assets:[0,1,2,3].map(i=>({id:`a${i}`,body:`unique body ${i}`,source:`s${i}`})),code:'fixture code'};
test('same bodies/bytes under all six reorderings; no loss or duplicate',()=>{
  const payloads=Array.from({length:6},(_,i)=>assetPayload(fixture,'reordered',i+1));
  assert.equal(new Set(payloads).size,6); assert.equal(new Set(payloads.map(x=>Buffer.byteLength(x))).size,1);
  for(const p of payloads) for(const a of fixture.assets) assert.equal(p.split(a.body).length-1,1);
});
test('stable assets stay byte identical',()=>assert.equal(assetPayload(fixture,'stable',1),assetPayload(fixture,'stable',6)));
test('long fixed prefix remains static across rounds and never changes assets',()=>{
  const longer={...fixture,system_padding:'fixed extra instructions '.repeat(100)};
  assert.equal(rawReplay(longer,'run',1,'reordered',1).messages[0].content,rawReplay(longer,'run',1,'reordered',6).messages[0].content);
  assert.equal(assetPayload(fixture,'reordered',1),assetPayload(longer,'reordered',1));
  assert.ok(rawReplay(longer,'run',1,'stable',1).messages[0].content.length>rawReplay(fixture,'run',1,'stable',1).messages[0].content.length);
});
test('raw history grows without rewriting; explicit compaction resets only user history',()=>{
  const a=rawReplay(fixture,'run',1,'reordered',2).messages,b=rawReplay(fixture,'run',1,'reordered',3).messages;
  assert.deepEqual(b.slice(0,a.length),a);
  const c=rawReplay(fixture,'run',1,'compacted',3).messages,d=rawReplay(fixture,'run',1,'compacted',4).messages;
  assert.deepEqual(c[0],d[0]); assert.notEqual(c[1].content,d[1].content); assert.ok(d.length<c.length);
});
test('missing usage is not zero; hit plus miss must equal input',()=>{
  assert.throws(()=>parseUsage({prompt_tokens:30}));
  assert.throws(()=>parseUsage({prompt_tokens:30,prompt_cache_hit_tokens:20,prompt_cache_miss_tokens:20,completion_tokens:2,total_tokens:32}));
  assert.deepEqual(parseUsage({prompt_tokens:30,prompt_cache_hit_tokens:20,prompt_cache_miss_tokens:10,completion_tokens:2,total_tokens:32}),
    {input:30,hit:20,miss:10,output:2,total:32});
});
test('weighted token hit rate, not average of per-request percentages',()=>{
  const s=aggregate([{tokens:{input:100,hit:90,miss:10,output:2},duration_ms:1},{tokens:{input:900,hit:0,miss:900,output:2},duration_ms:3}]);
  assert.equal(s.hit_rate,.09); assert.equal(s.total,1004);
});
