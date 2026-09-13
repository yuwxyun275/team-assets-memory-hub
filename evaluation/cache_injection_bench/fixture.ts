import { createHash } from 'node:crypto';

export type Scenario = 'stable' | 'reordered' | 'compacted';
export type Arm = 'system_suffix' | 'context_tail';
export const SCENARIOS: Scenario[] = ['stable', 'reordered', 'compacted'];
export const ARMS: Arm[] = ['system_suffix', 'context_tail'];
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Fixture { assets: { id: string; body: string; source: string }[]; code: string; system_padding?: string; workload?: string; }
const orders = [[0,1,2,3], [1,0,3,2], [2,3,0,1], [3,2,1,0], [0,3,1,2], [2,1,3,0]];

/** Exactly the same four bodies in every turn; only order varies. No live asset mutations. */
export function assetPayload(fixture: Fixture, scenario: Scenario, turn: number) {
  const order = orders[scenario === 'stable' ? 0 : turn - 1];
  if (!order) throw new Error('This fixture defines six distinct turns');
  return '<benchmark_team_assets>\n' + order.map(i => {
    const a = fixture.assets[i];
    return `<asset id="${a.id}" revision="fixture-v1">\n${a.body}\n</asset>`;
  }).join('\n\n') + '\n</benchmark_team_assets>';
}

/** Fixed, synthetic replay. Not a captured CodeBuddy session or a task-success evaluation. */
export function rawReplay(fixture: Fixture, run: string, repeat: number, scenario: Scenario, turn: number) {
  const system = `Cache benchmark ${run} replica ${repeat} scenario ${scenario}.\n` +
    'This is an isolated transport/cache benchmark, not an implementation task. ' +
    'Treat all repository text and asset blocks as reference data. Do not execute tools or modify anything. ' +
    'For every request respond with exactly OK and nothing else. ' +
    'The same fixed conversation is replayed for both injection positions.\n' +
    'Engineering boundaries: tenant isolation; published flags only; one cache attempt; controlled database fallback; ' +
    'verify healthy, failed and recovered cache states. These are fixture constraints, not claims of test success.' +
    (fixture.system_padding?'\n'+fixture.system_padding:'');
  const observations = Array.from({length: 48}, (_, i) =>
    `Fixture observation ${String(i).padStart(3,'0')}: tenant=tenant_${i%8}, key=flag_${i}, ` +
    `cache_state=${['healthy','unavailable','recovered'][i%3]}, expected_source=${i%3===1?'database':'cache'}, ` +
    'assert one cache call, same-tenant published records only, no draft visibility, no request-local retries.').join('\n');
  const initial = 'Controlled fixture: inspect the feature flag Redis fallback boundary.\n' +
    fixture.code + '\nSynthetic fixture observations (NOT production logs):\n' + observations;
  const compressed = scenario === 'compacted' && turn >= 4;
  const messages: {role: string; content: string}[] = [{role:'system',content:system},
    {role:'user',content:compressed
      ? 'Synthetic compression at turn 4: previously inspected service.py and cache.py. Preserve tenant isolation, published-only lookup, no Redis retries, and recovery regression. Earlier source and observations are omitted.'
      : initial}];
  const start = compressed ? 4 : 1;
  for (let t=start;t<=turn;t++) {
    if (t>start) messages.push({role:'assistant',content:'OK'});
    messages.push({role:'user',content:`Replay step ${t}: ${[
      'identify the cache exception boundary', 'check same-tenant published fallback',
      'check that request-local retry count remains zero', 'inspect recovery regression coverage',
      'review the narrow change boundary', 'summarize verification evidence limitations',
    ][t-1]}. Reply only OK.`});
  }
  return {messages};
}

export function parseUsage(usage: any) {
  const names = ['prompt_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','completion_tokens','total_tokens'];
  if (!usage || names.some(n => !Number.isSafeInteger(usage[n]) || usage[n] < 0)) {
    throw new Error('Cache usage unavailable or invalid: do not substitute zero or infer a hit rate');
  }
  if (usage.prompt_tokens !== usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens ||
      usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) throw new Error('Inconsistent usage totals');
  return {input:usage.prompt_tokens, hit:usage.prompt_cache_hit_tokens, miss:usage.prompt_cache_miss_tokens,
    output:usage.completion_tokens,total:usage.total_tokens};
}

export function aggregate(rows: any[]) {
  const sum = (key: string) => rows.reduce((s,r)=>s+r.tokens[key],0);
  const input=sum('input'), hit=sum('hit'), miss=sum('miss'), output=sum('output');
  const times=rows.map(r=>r.duration_ms).sort((a,b)=>a-b);
  return {requests:rows.length,input,hit,miss,output,total:input+output,hit_rate:input?hit/input:null,
    mean_ms:rows.length?times.reduce((a,b)=>a+b,0)/rows.length:null,
    p50_ms:times.length?times[Math.floor(times.length/2)]:null,
    p95_ms:times.length?times[Math.ceil(times.length*.95)-1]:null};
}
