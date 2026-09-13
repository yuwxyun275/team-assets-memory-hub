import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const count = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;

export function normalizeMainCall(row) {
  const usage = row.usage ?? {}, input = count(usage.prompt_tokens ?? usage.input_tokens);
  const openai = 'prompt_tokens' in usage;
  const read = count(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens);
  const write = openai ? 0 : count(usage.cache_creation_input_tokens);
  return { call_id: row.request_id ?? row.id, purpose: 'coding', task_id: row.task_id ?? row.run_id ?? null,
    model: row.model ?? row.response?.model ?? null, status: row.status === 'failed' ? 'failed' : 'completed',
    input_tokens: openai ? input : input !== null && read !== null && write !== null ? input + read + write : null,
    output_tokens: count(usage.completion_tokens ?? usage.output_tokens), cache_read_tokens: read,
    // OpenAI Chat Completions has no separate cache-creation token category.
    cache_write_tokens: write,
    duration_ms: count(row.duration_ms), source: 'main_provider_audit' };
}
export function account(main, background, prices = []) {
  const calls = new Map();
  for (const row of [...main.map(normalizeMainCall), ...background.map(r => ({ ...r.data, source: 'background_provider_sdk' }))]) {
    if (!row.call_id) throw new Error('Every call needs a stable request/call id');
    const key = `${row.source}:${row.call_id}`;
    if (calls.has(key) && JSON.stringify(calls.get(key)) !== JSON.stringify(row)) throw new Error('Conflicting duplicate call id');
    calls.set(key, row);
  }
  const rows = [...calls.values()];
  const summarize = subset => {
    const sum = key => subset.every(r => count(r[key]) !== null) ? subset.reduce((n, r) => n + r[key], 0) : null;
    const costs = subset.map(r => {
      const p = prices.find(p => p.model === r.model);
      if (!p || !p.version || !p.currency || [p.input_per_million, p.output_per_million].some(v => count(v) === null)) return null;
      if ([r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens].some(v => count(v) === null)) return null;
      if ((r.cache_read_tokens && count(p.cache_read_per_million) === null) || (r.cache_write_tokens && count(p.cache_write_per_million) === null)) return null;
      const plain = r.input_tokens - r.cache_read_tokens - r.cache_write_tokens; if (plain < 0) return null;
      return { currency: p.currency, price_version: p.version,
        amount: (plain * p.input_per_million + r.output_tokens * p.output_per_million
          + r.cache_read_tokens * (p.cache_read_per_million ?? 0) + r.cache_write_tokens * (p.cache_write_per_million ?? 0)) / 1e6 };
    });
    const currencies = new Set(costs.filter(Boolean).map(c => c.currency));
    return { calls: subset.length, input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
      missing_usage_calls: subset.filter(r => count(r.input_tokens) === null || count(r.output_tokens) === null).length,
      incomplete_calls: subset.filter(r => r.status !== 'completed').length,
      estimated_cost: costs.every(Boolean) && currencies.size === 1 ? { amount: costs.reduce((n, c) => n + c.amount, 0), currency: [...currencies][0], price_versions: [...new Set(costs.map(c => c.price_version))] } : null };
  };
  const setup = rows.filter(r => !r.task_id && r.purpose !== 'coding');
  const byTask = Object.fromEntries([...new Set(rows.filter(r => r.task_id).map(r => r.task_id))].map(task => [task, summarize(rows.filter(r => r.task_id === task))]));
  return { schema_version: 'team-asset-cost-report/v1', total: summarize(rows), asset_preparation: summarize(setup),
    by_task: byTask, by_purpose: Object.fromEntries([...new Set(rows.map(r => r.purpose))].map(p => [p, summarize(rows.filter(r => r.purpose === p))])),
    main_calls: main.length, background_calls: background.length, records: rows,
    interpretation: 'Provider-reported tokens; estimates require explicit versioned prices and cache fields. Preparation is counted once, not charged again to every task. Call durations are not user-visible wall time. Missing historical calls cannot be reconstructed.' };
}
function read(path) {
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch { return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mainFile, backgroundFile, priceFile, outputFile] = process.argv.slice(2);
    if (!outputFile) throw new Error('Usage: node accounting.mjs main.jsonl background-costs.json prices.json report.json');
    const bg = read(backgroundFile);
    const report = account(read(mainFile), bg.items ?? bg, read(priceFile));
    writeFileSync(outputFile, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
}
