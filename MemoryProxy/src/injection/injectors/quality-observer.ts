import { createHash } from "node:crypto";
import type { ContextMessage } from "../types.js";
import type { MetadataClient } from "../../meta/client.js";
import { codebuddySummary } from "../../common/codebuddy-summary.js";
import { extractUserQueryText } from "../../common/user-query-extractor.js";

export interface QualityEvent { id: string; role: "user" | "assistant" | "tool_call" | "tool_result"; content: string; tool_call_id?: string }
export interface QualityScene {
  schema_version: "recommendation-scene/v1"; request_id: string; turn: number;
  query: string; task: string; active_paths: string[]; errors: string[];
  events: QualityEvent[]; truncated: boolean;
}
/** Called before retrieval and kept outside model messages. Captures bounded
 * exact excerpts, not a model-written summary of the successful outcome. */
export function qualityScene(input: { requestId: string; turn: number; query: string; task: string;
  messages: ContextMessage[]; activePaths: string[]; errors: string[] }): QualityScene {
  const safe = (s: string) => /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s) ? "" : s;
  const query = safe(input.query).slice(0, 4000), task = safe(input.task).slice(0, 4000);
  const candidates = qualityEvents(input.messages);
  // Board requirements are user-provided context, with their own source handle.
  const requirements: QualityEvent[] = task ? [{ id: `task-${createHash("sha256").update(task).digest("hex")}`, role: "user", content: task }] : [];
  const current: QualityEvent[] = query ? [{ id: `query-${createHash("sha256").update(query).digest("hex")}`, role: "user", content: query }] : [];
  const events: QualityEvent[] = []; let remaining = 16000;
  for (const event of [...requirements, ...current, ...candidates.slice(-10).reverse()]) {
    if (events.length >= 12 || remaining <= 0) break;
    if (events.some(e => e.id === event.id)) continue;
    const content = event.content.slice(0, Math.min(4000, remaining));
    remaining -= content.length;
    events.push({ ...event, content });
  }
  const order = new Map([...requirements, ...candidates, ...current].map((e, i) => [e.id, i]));
  events.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { schema_version: "recommendation-scene/v1", request_id: input.requestId, turn: input.turn,
    query, task, active_paths: input.activePaths.map(safe).filter(Boolean).slice(-12).map(s => s.slice(0, 1000)),
    errors: input.errors.map(safe).filter(Boolean).slice(-6).map(s => s.slice(0, 1000)), events,
    truncated: candidates.length > 10 || candidates.some(e => e.content.length > 4000) || remaining <= 0
      || input.query.length > 4000 || input.task.length > 4000 };
}
/** Preserve task text. Never emit credentials; no model judge or tool execution in the Proxy. */
export function qualityEvents(messages: ContextMessage[]): QualityEvent[] {
  const events: QualityEvent[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    for (const block of message.blocks) {
      if (!block.content || typeof block.content !== "string") continue;
      if (/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(block.content)) continue;
      const role = block.type === "tool_result" || message.role === "tool" ? "tool_result" : block.type === "tool_use" ? "tool_call" : message.role === "user" ? "user" : "assistant";
      const tool = String(block.metadata?.tool_id ?? block.metadata?.tool_use_id ?? "");
      const summary = role === 'user' ? codebuddySummary(block.content) : undefined;
      // Client summaries may quote old tool output. They are not new observations.
      const observed = summary ? extractUserQueryText(summary.current) : block.content;
      // Bounded chunks retain exact text and stable identities across request retries.
      for (let offset = 0; offset < observed.length && offset < 120000; offset += 12000) {
        const content = observed.slice(offset, offset + 12000);
        const id = createHash("sha256").update(JSON.stringify([role, tool, offset, content])).digest("hex");
        events.push({ id, role, content, ...(tool ? { tool_call_id: tool } : {}) });
      }
    }
  }
  return events;
}

export async function observeQualityWindow(client: MetadataClient, team: string, task: string, session: string, events: QualityEvent[]) {
  if (!task || !events.length) return;
  const open = await client.quality<{ items: { key: string; baseline_event_ids: string[]; event_ids: string[] }[] }>("open-exposures", { team_id: team, task_id: task, session_id: session });
  for (const e of open.items) {
    const seen = new Set([...e.baseline_event_ids, ...e.event_ids]);
    const fresh = events.filter(v => !seen.has(v.id));
    // Sequential bounded batches, no giant conversation upload. Core durably acknowledges each batch.
    for (let i = 0; i < fresh.length && i < 30; i += 5) {
      await client.quality("observe", { team_id: team, observation: { exposure_id: e.key, events: fresh.slice(i, i + 5) } });
    }
  }
}
