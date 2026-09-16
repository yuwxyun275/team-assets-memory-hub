/** Re-run deterministic gates over fixed snapshots without a model request. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runRules } from '../../MemoryCore/src/asset-quality/rules.js';
const dataset = process.argv[2];
if (!dataset) throw new Error('Usage: tsx replay-rules.ts <prepared-dataset>');
const input = resolve('evaluation/parameter_calibration/results/quality-input.json');
const saved = JSON.parse(readFileSync(input, 'utf8'));
const raw = JSON.parse(readFileSync(resolve(dataset, 'assets/candidates.json'), 'utf8'));
const byId = new Map(raw.map((r: any) => [r.asset_id, r.snapshot]));
for (const row of saved.rows) {
  const rules = runRules(byId.get(row.asset_id) as any);
  row.current_rule_blockers = rules.checks.filter(c => c.status !== 'pass').map(c => c.id);
}
writeFileSync(input, JSON.stringify(saved, null, 2) + '\n');
console.log(JSON.stringify({ snapshots: saved.rows.length, integrity_holds: saved.rows.filter((r: any) => r.current_rule_blockers.includes('input.verification_integrity')).length }));
