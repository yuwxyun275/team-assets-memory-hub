import type { AgentContext, ContextBlock, ContextMessage } from "../injection/types.js";
import type { CoreSkillConfig } from "../types.js";
import { getMetadataClient } from "../meta/client.js";
import { DISCLOSURE_NOTICE, estimateDisclosureTokens, hasAssetBody, referenceKey, renderAssetBody, renderAssetCard, visibleTexts, type PublishedAsset } from "./disclosure.js";
import { AssetHistoryStore, historyDigest, historyScope, type AssetHistoryState, type HistoryEntry, type HistoryReference } from "./history-store.js";
import { codebuddySummary } from "../common/codebuddy-summary.js";
import { resolveRuntimeContext } from "./runtime-context.js";

// Sorting JSON object keys does NOT normalize strings, whitespace or array order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function messageFingerprint(message: ContextMessage): string {
  return historyDigest(["message-v1", message.role, message.blocks.map(block => [block.type, block.content,
    canonical(Object.fromEntries(Object.entries(block.metadata ?? {}).filter(([key]) => key !== "cache_control")))]),
    message.metadata?.reasoning_content ?? null]);
}
export function prefixFingerprints(messages: ContextMessage[]): string[] {
  let prefix = historyDigest(["history-v1"]);
  return messages.map(message => prefix = historyDigest(["prefix-v1", prefix, messageFingerprint(message)]));
}

/** Recognize complete, standalone client summary envelopes, never arbitrary
 * occurrences of "summary"/"摘要" or a changed fingerprint. This is a protocol
 * heuristic, not cryptographic proof of compaction. Unknown formats fail closed.
 */
export function compactionBoundary(messages: ContextMessage[]): number | undefined {
  // CodeBuddy may keep leading wrapped control questions before cb_summary.
  // Do not assume its compression envelope is the first non-system message.
  const cbIndex=messages.findIndex(m=>m.role==='user'&&m.blocks.length===1&&m.blocks[0].type==='text'&&!!codebuddySummary(m.blocks[0].content));
  if(cbIndex>=0&&messages.slice(0,cbIndex).every(m=>m.role==='system'||(m.role==='user'&&m.blocks.length===1
    &&m.blocks[0].type==='text'&&/^\s*<system[-_]reminder>/.test(m.blocks[0].content))))return cbIndex;
  const index = messages.findIndex(m => m.role !== "system");
  if (index < 0) return;
  const message = messages[index];
  if (message.role !== "user" || message.blocks.length !== 1 || message.blocks[0].type !== "text") return;
  const text = message.blocks[0].content.trim();
  if (codebuddySummary(text) || /^<(conversation_summary|context_summary)>[\s\S]+<\/\1>$/.test(text)
      || /^\[上下文压缩摘要\]\s*\S/.test(text)
      || /^This session is being continued from a previous conversation that ran out of context\./.test(text)) return index;
}

function pendingTools(messages: ContextMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) for (const block of message.blocks) {
    if (block.type === "tool_use") pending.add(String(block.metadata?.tool_id || "unknown"));
    if (block.type === "tool_result") pending.delete(String(block.metadata?.tool_use_id || "unknown"));
  }
  return pending.size > 0;
}
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function historyDirectoryCard(base: string, space: string, session: string): string {
  return `<team_asset_history_directory>\n历史资产按需检索入口（只列本会话实际提供过且仍可访问的卡片；不是正文或采用证明）。可分页，query 按名称筛选：\n`
    + `curl --fail-with-body --silent --show-error --max-time 20 -X POST ${quote(`${base.replace(/\/$/, "")}/asset-bridge/list`)} -H 'content-type: application/json' -H ${quote(`x-tdai-service-id: ${space}`)} -H ${quote(`x-conversation-id: ${session}`)} --data-raw '{"query":"","offset":0,"limit":10}'\n</team_asset_history_directory>`;
}
export interface AssetHistoryOptions {
  store: AssetHistoryStore;
  core: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">;
  bridgeBaseUrl: string;
  tokenBudget: number;
  pinnedAssetIds?: string[];
  loadTurnFloor?: (session: any) => Promise<number>;
}
export interface HistoryHooks {
  filter(blocks: ContextBlock[]): ContextBlock[];
  capture(blocks: ContextBlock[]): void;
}

/** Runs around the real pipeline, before any other injector modifies messages.
 * Only this Proxy's exact, persisted standalone messages are stripped from a
 * client echo. Client/tool history is otherwise never rewritten.
 */
export class AssetHistoryCoordinator {
  constructor(private readonly options: AssetHistoryOptions) {}

  prepare(ctx: AgentContext) { return resolveRuntimeContext(ctx, this.options.store, this.options.loadTurnFloor); }

  async process<T>(ctx: AgentContext, run: () => Promise<T>): Promise<T> {
    const custom = ctx.metadata.custom ?? {};
    const session = custom.session as any;
    const user = ctx.metadata.userId || session?.user_id;
    const space = ctx.metadata.spaceId;
    const key = custom.userKey;
    if (ctx.metadata.readOnly || !space || !user || typeof key !== "string" || !key
        || !session?.team_id || !session?.agent_id || !session?.task_id || !session?.session_id) return run();
    if (session.user_id && session.user_id !== user) throw new Error("asset_history_identity_mismatch");
    const scope = historyScope({ space, user, team: session.team_id, agent: session.agent_id,
      task: session.task_id, session: session.session_id, source: ctx.metadata.agentSource });
    const client = getMetadataClient(this.options.core, space, key);
    // Live permission/publication checks occur BEFORE any replay, even if the
    // ranker is unavailable or this is a greeting/control turn.
    const accessible = await client.listAccessibleAssets({ user_id: user, team_id: session.team_id, agent_id: session.agent_id, action: "use" });
    const allowed = new Map<string, PublishedAsset>();
    for (const raw of accessible) {
      const asset = raw as unknown as PublishedAsset;
      if (asset.quality_publication?.revision_id && typeof asset.quality_publication.snapshot?.body === "string") {
        allowed.set(referenceKey(asset.asset_id, asset.quality_publication.revision_id), asset);
      }
    }
    return this.options.store.transaction(scope, async storedState => {
      const delivery = ctx.metadata.assetDelivery;
      const state = delivery ? structuredClone(storedState) : storedState;
      const before = historyDigest({...storedState,runtime:undefined});
      const originalEntryIds = new Set(storedState.entries.map(e => e.id));
      const originalLive = new Set(storedState.liveRefs);
      const suppressed = new Set(state.suppressedRefs ?? []);
      for (const ref of suppressed) allowed.delete(ref);
      const permittedAccessible = accessible.filter(raw => {
        const p = (raw as unknown as PublishedAsset).quality_publication;
        return !p || !suppressed.has(referenceKey(raw.asset_id, p.revision_id));
      });
      // Strip only byte-identical, known standalone echo messages, not a user
      // quote, partial card, summary mention or arbitrary XML-looking content.
      const owned = new Set(state.entries.map(entry => entry.content));
      const base = ctx.messages.filter(m => !(m.role === "user" && m.blocks.length === 1
        && m.blocks[0].type === "text" && owned.has(m.blocks[0].content)));
      ctx.messages = [...base];
      ctx.metadata.custom = { ...custom, assetHistoryClientMessages: structuredClone(base), assetHistoryAccessibleAssets: permittedAccessible };
      const hashes = base.map(messageFingerprint), prefixes = prefixFingerprints(base);
      const positions = new Map(prefixes.map((p, index) => [p, index]));
      const now = Date.now();
      const expired = state.updated > 0 && now - state.updated > 30 * 86400_000;
      const changed = !!state.lastPrefix && !positions.has(state.lastPrefix);
      const boundary = changed && !expired ? compactionBoundary(base) : undefined;
      const compacted = boundary !== undefined;
      const previousLive = state.liveRefs.filter(ref => allowed.has(ref));
      const validEntries: HistoryEntry[] = [];
      let policyChanged = false;
      for (const entry of state.entries.filter(e => e.active)) {
        const position = positions.get(entry.anchor);
        const permitted = entry.refs.every(ref => allowed.has(ref));
        if (expired || compacted || position === undefined || !permitted || pendingTools(base.slice(0, position + 1))) {
          entry.active = false;
          entry.retired_reason = expired ? "expired" : compacted ? "compacted" : !permitted ? "permission_or_revision" : "history_changed";
          if (!permitted) policyChanged = true;
        } else validEntries.push(entry);
      }
      if (changed || expired) state.generation++;
      state.liveRefs = expired ? [] : compacted || !changed ? previousLive
        : [...new Set(validEntries.flatMap(e => e.refs))]; // never revive another branch's catalogue

      // Refresh exact-version reader manifests. Long catalogues can exceed the
      // Core manifest window; list/read bridges re-register individual permitted
      // references on demand as well.
      for (let i = 0; i < state.liveRefs.length; i += 32) {
        const references = state.liveRefs.slice(i, i + 32).map(ref => state.references[ref]).filter(Boolean)
          .map(({ asset_id, revision_id }) => ({ asset_id, revision_id }));
        if (references.length) await client.quality("disclosure-remember", {
          team_id: session.team_id, agent_id: session.agent_id, task_id: session.task_id, session_id: session.session_id, references,
        });
      }
      // Reading in a real tool result promotes overflow priority, not intrinsic
      // quality or proof of contribution. Mere card visibility is not a read.
      const texts = visibleTexts(base.filter(m => m.blocks.some(b => b.type === "tool_result")));
      for (const ref of state.liveRefs) if (hasAssetBody(texts, allowed.get(ref)!)) state.references[ref].last_read = now;
      const directory = historyDirectoryCard(this.options.bridgeBaseUrl, space, session.session_id);
      let remaining = Math.max(0, this.options.tokenBudget);
      const insertions: { after: number; entry: HistoryEntry }[] = [];
      let overflow = false;
      for (const entry of validEntries) {
        const cost = estimateDisclosureTokens(entry.content);
        if (cost > remaining) { entry.active = false; entry.retired_reason = "budget"; overflow = true; continue; }
        remaining -= cost;
        insertions.push({ after: positions.get(entry.anchor)!, entry });
      }
      const createEntry = (content: string, refs: string[], after: number, kind: HistoryEntry["kind"]): HistoryEntry => {
        const anchor = prefixes[after];
        const id = historyDigest([scope, state.generation, anchor, content]);
        const existing = state.entries.find(e => e.id === id);
        if (existing) { existing.active = true; delete existing.retired_reason; return existing; }
        const entry: HistoryEntry = { id, anchor, content, refs, kind, created: now, active: true };
        state.entries.push(entry); return entry;
      };
      // Compaction is the only history rewrite allowed to carry the full live
      // catalogue. Never replace or prepend the static system prompt.
      if ((compacted || policyChanged || overflow) && base.length && !pendingTools(base.slice(0, (boundary ?? base.length - 1) + 1))) {
        const present = new Set(insertions.flatMap(i => i.entry.refs));
        const candidates = state.liveRefs.filter(ref => !present.has(ref));
        const all = candidates.map(ref => state.references[ref]);
        const overhead = estimateDisclosureTokens(`${DISCLOSURE_NOTICE}\n\n${directory}`);
        // Keep ALL if they fit; read-priority is used only for overflow.
        if (estimateDisclosureTokens(all.map(r => r.card).join("\n\n")) + overhead > remaining) {
          const pinned = new Set(this.options.pinnedAssetIds ?? []);
          const query = base.filter(m => m.role === "user").at(-1)?.blocks.filter(b => b.type === "text").map(b => b.content).join("\n").slice(0, 4000).toLowerCase() || "";
          // Deterministic overflow preference, NOT another asset-quality verdict
          // or a claim of semantic understanding. Preserve original order on ties.
          const terms = [...new Set(query.match(/[a-z0-9_./-]{2,}|[\u4e00-\u9fff]{2}/g) || [])].slice(0, 100);
          const relevance = (ref: string) => terms.filter(term => state.references[ref].card.toLowerCase().includes(term)).length;
          candidates.sort((a, b) => Number(pinned.has(state.references[b].asset_id)) - Number(pinned.has(state.references[a].asset_id))
            || state.references[b].last_read - state.references[a].last_read || relevance(b) - relevance(a));
        }
        const selected: string[] = [], cards: string[] = [];
        let budget = remaining - overhead;
        for (const ref of candidates) {
          const card = state.references[ref].card, cost = estimateDisclosureTokens(`${card}\n\n`);
          if (cost <= budget) { cards.push(card); selected.push(ref); budget -= cost; }
        }
        const content = [DISCLOSURE_NOTICE, ...cards, directory].join("\n\n");
        if (state.liveRefs.length && estimateDisclosureTokens(content) <= remaining) {
          const after = boundary ?? base.length - 1;
          insertions.push({ after, entry: createEntry(content, selected, after, "checkpoint") });
          remaining -= estimateDisclosureTokens(content);
        }
      }
      insertions.sort((a, b) => a.after - b.after); // stable within a boundary
      let shift = 0;
      for (const insertion of insertions) {
        ctx.messages.splice(insertion.after + 1 + shift++, 0, { role: "user", blocks: [{ type: "text", content: insertion.entry.content }], metadata: { proxyAssetAugment: true } });
      }
      const currentTexts = visibleTexts(ctx.messages);
      ctx.metadata.custom.assetHistoryVisibleCardKeys = state.liveRefs.filter(ref =>
        currentTexts.some(text => text.includes(state.references[ref].card)));
      const extractReferences = (content: string): [string, HistoryReference][] => {
        const refs: [string, HistoryReference][] = [];
        for (const [ref, asset] of allowed) {
          const card = renderAssetCard(asset, this.options.bridgeBaseUrl, space, session.session_id);
          const full = renderAssetBody(asset.asset_id, asset.quality_publication.revision_id, asset.quality_publication.snapshot.body);
          if (content.includes(card) || content.includes(full)) refs.push([ref, {
            asset_id: asset.asset_id, revision_id: asset.quality_publication.revision_id,
            name: asset.name || asset.asset_id, card, last_read: state.references[ref]?.last_read || 0,
          }]);
        }
        return refs;
      };
      const hooks: HistoryHooks = {
        filter: blocks => blocks.map(block => {
          if (block.type !== "text" || !block.content) return block;
          if (pendingTools(base) || !base.length) return { ...block, type: "custom" as const, content: "" };
          const hasDirectory = visibleTexts(ctx.messages).some(text => text.includes(directory));
          const suffix = hasDirectory ? "" : `\n\n${directory}`;
          let content = block.content + suffix;
          if (estimateDisclosureTokens(content) > remaining) {
            // Whole cards only. Never slice a tool command/body to fit a budget.
            const parts = [DISCLOSURE_NOTICE];
            for (const [, ref] of extractReferences(block.content)) {
              if (estimateDisclosureTokens([...parts, ref.card].join("\n\n") + suffix) <= remaining) parts.push(ref.card);
            }
            content = parts.length > 1 ? parts.join("\n\n") + suffix : "";
          }
          const actualTexts = [...visibleTexts(ctx.messages), content];
          const bodyIds = Array.isArray(block.metadata?.assetIds) ? block.metadata.assetIds.filter(id =>
            [...allowed.values()].some(asset => asset.asset_id === id && hasAssetBody(actualTexts, asset))) : [];
          return { ...block, type: content ? "text" as const : "custom" as const, content,
            metadata: { ...block.metadata, assetIds: bodyIds } };
        }),
        capture: blocks => {
          const content = blocks.filter(b => b.type === "text").map(b => b.content).join("\n\n");
          if (!content || !base.length) return;
          const refs = extractReferences(content);
          for (const [ref, value] of refs) {
            state.references[ref] = value;
            if (!state.liveRefs.includes(ref)) state.liveRefs.push(ref);
          }
          createEntry(content, refs.map(([ref]) => ref), base.length - 1, "append");
          remaining -= estimateDisclosureTokens(content);
        },
      };
      ctx.metadata.custom.assetHistoryHooks = hooks;
      try {
        const result = await run();
        state.updated = now;
        state.lastPrefix = prefixes.at(-1) || "";
        state.lastMessages = hashes;
        if (delivery) delivery.defer(async actualTexts => {
          await this.options.store.transaction(scope, async current => {
            // A concurrent branch must never be overwritten by an old response.
            if (historyDigest({...current,runtime:undefined}) !== before) {
              console.warn('[asset-history] concurrent history changed; stale prepared replay not committed');
              return;
            }
            state.entries = state.entries.filter(e => originalEntryIds.has(e.id) || actualTexts.some(t => t.includes(e.content)));
            const deliveredRefs = new Set(state.entries.filter(e => !originalEntryIds.has(e.id)).flatMap(e => e.refs));
            state.liveRefs = state.liveRefs.filter(r => originalLive.has(r) || deliveredRefs.has(r));
            for (const r of Object.keys(state.references)) if (!originalLive.has(r) && !deliveredRefs.has(r)) delete state.references[r];
            Object.assign(current, {...state,runtime:current.runtime});
          });
        });
        // Diagnostics contain counts/reasons only, never client text or keys.
        console.log(`[asset-history] ${compacted ? "checkpoint" : changed ? "history-change" : "replay"} generation=${state.generation} replayed=${insertions.length} live=${state.liveRefs.length}`);
        return result;
      } finally { delete ctx.metadata.custom.assetHistoryHooks; }
    });
  }
}
