import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { QualityRecord, QualityRecords } from "./records.js";

export type UsageContext = {
  records: QualityRecords; team: string; actor: string; purpose: string;
  task_id?: string; asset_id?: string; job_id?: string;
};
const context = new AsyncLocalStorage<UsageContext>();
export function withModelUsage<T>(scope: UsageContext, work: () => Promise<T>): Promise<T> {
  return context.run(scope, work);
}
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Store metadata only: no prompt, response, credentials or provider error text. */
export async function measuredModelText(model: string, run: () => Promise<{
  text: string; usage?: any; response?: { id?: string }; providerMetadata?: any;
}>): Promise<string> {
  const scope = context.getStore(), start = Date.now(), callId = randomUUID();
  if (scope && !await scope.records.cas({ key: `model-usage:${callId}`, kind: "model-usage", team: scope.team, rev: 0, updated: start,
    data: { call_id: callId, actor: scope.actor, purpose: scope.purpose, task_id: scope.task_id ?? null,
      asset_id: scope.asset_id ?? null, job_id: scope.job_id ?? null, model, started_at: start,
      status: "started", usage_status: "unavailable", input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, source: "provider_sdk" } }, 0)) throw new Error("model_usage_start_not_saved");
  let result: Awaited<ReturnType<typeof run>> | undefined;
  try { result = await run(); return result.text; }
  finally {
    if (scope) {
      const u = result?.usage;
      const input = number(u?.inputTokens), output = number(u?.outputTokens);
      const row: QualityRecord = { key: `model-usage:${callId}`, kind: "model-usage", team: scope.team, rev: 0, updated: Date.now(), data: {
        call_id: callId, actor: scope.actor, purpose: scope.purpose, task_id: scope.task_id ?? null,
        asset_id: scope.asset_id ?? null, job_id: scope.job_id ?? null, model,
        request_id: result?.response?.id ?? null, started_at: start, duration_ms: Date.now() - start,
        status: result ? "completed" : "failed", input_tokens: input, output_tokens: output,
        cache_read_tokens: number(u?.inputTokenDetails?.cacheReadTokens),
        cache_write_tokens: number(u?.inputTokenDetails?.cacheWriteTokens),
        usage_status: input === null || output === null ? "unavailable" : "reported",
        timing_scope: "background_call_not_user_wait", source: "provider_sdk",
      } };
      if (!await scope.records.cas({ ...row, rev: 1 }, 1)) throw new Error("model_usage_record_not_saved");
    }
  }
}

export type Price = { model: string; version: string; currency: string; input_per_million: number;
  output_per_million: number; cache_read_per_million?: number; cache_write_per_million?: number };
export function summarizeModelUsage(rows: QualityRecord[], prices: Price[] = []) {
  const sum = (key: string) => rows.every(r => number(r.data[key]) !== null)
    ? rows.reduce((n, r) => n + r.data[key], 0) : null;
  const estimates = rows.map(r => {
    const d = r.data, p = prices.find(x => x.model === d.model);
    if (!p || number(d.input_tokens) === null || number(d.output_tokens) === null) return null;
    if (number(d.cache_read_tokens) === null || number(d.cache_write_tokens) === null) return null;
    const plain = d.input_tokens - d.cache_read_tokens - d.cache_write_tokens;
    if (plain < 0 || (d.cache_read_tokens && p.cache_read_per_million === undefined)
      || (d.cache_write_tokens && p.cache_write_per_million === undefined)) return null;
    return { currency: p.currency, price_version: p.version,
      amount: (plain * p.input_per_million + d.output_tokens * p.output_per_million
        + d.cache_read_tokens * (p.cache_read_per_million ?? 0) + d.cache_write_tokens * (p.cache_write_per_million ?? 0)) / 1e6 };
  });
  const currencies = new Set(estimates.filter(Boolean).map(x => x!.currency));
  return { calls: rows.length, failed_calls: rows.filter(r => r.data.status === "failed").length,
    missing_usage_calls: rows.filter(r => r.data.usage_status !== "reported").length,
    input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"),
    background_call_ms: rows.reduce((n, r) => n + (number(r.data.duration_ms) ?? 0), 0),
    estimated_cost: estimates.every(Boolean) && currencies.size === 1 ? {
      amount: estimates.reduce((n, x) => n + x!.amount, 0), currency: [...currencies][0],
      price_versions: [...new Set(estimates.map(x => x!.price_version))],
    } : null,
    scope: "background_model_calls", includes_main_coding_calls: false,
    cost_status: estimates.every(Boolean) && currencies.size === 1 ? "estimated" : "missing_usage_or_price",
  };
}
