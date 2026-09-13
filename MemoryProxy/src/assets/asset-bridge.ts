import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { getSessionStore } from "../session/store.js";
import { getMetadataClient } from "../meta/client.js";
import type { ProxyConfig } from "../types.js";
import { renderAssetBody, bodyHash } from "./disclosure.js";
import { configuredHistoryStore, historyScope } from "./history-store.js";
import {benchmarkBinding} from "./benchmark.js";

/** Same existing terminal/curl transport as skill-bridge. The initialized
 * conversation is a capability: keep this endpoint behind the same gateway.
 * Never accept user/team/agent/task credentials or upstream URLs from the LLM.
 */
export function createAssetBridgeHandler(config: ProxyConfig) {
  return async (c: Context): Promise<Response> => {
    const error = (status: number, message: string) => new Response(JSON.stringify({ error: message }), {
      status, headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
    if (!config.injection?.enabled || !config.injection.teamAssets?.enabled
        || !config.injection.teamAssets.progressiveDisclosure) return error(404, "asset_disclosure_disabled");
    const listing = c.req.path === "/asset-bridge/list";
    const forgetting = c.req.path === "/asset-bridge/forget";
    if (c.req.method !== "POST" || (!listing && !forgetting && c.req.path !== "/asset-bridge/read")) return error(404, "unknown_asset_read_endpoint");
    if (!(c.req.header("content-type") || "").includes("application/json")) return error(415, "json_required");
    const space = c.req.header("x-tdai-service-id") || "";
    const sid = c.req.header("x-conversation-id") || "";
    if (!space || !sid || space.length > 200 || sid.length > 200) return error(401, "session_required");
    // Bound size before JSON parsing, including chunked requests.
    let raw = "";
    const reader = c.req.raw.body?.getReader();
    if (!reader) return error(400, "json_required");
    const decoder = new TextDecoder(); let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 4096) { await reader.cancel(); return error(413, "request_too_large"); }
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw); } catch { return error(400, "invalid_json"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return error(400, "invalid_request");
    if (listing) {
      if (Object.keys(data).some(k => !["query", "offset", "limit"].includes(k))
          || (data.query !== undefined && (typeof data.query !== "string" || data.query.length > 200))
          || (data.offset !== undefined && (!Number.isInteger(data.offset) || Number(data.offset) < 0 || Number(data.offset) > 10000))
          || (data.limit !== undefined && (!Number.isInteger(data.limit) || Number(data.limit) < 1 || Number(data.limit) > 20))) return error(400, "invalid_list_query");
    } else if (Object.keys(data).some(k => !["asset_id", "revision_id"].includes(k))
        || [data.asset_id, data.revision_id].some(v => typeof v !== "string" || !v || v.length > 200)) return error(400, "asset_id_and_revision_id_required");

    const store = getSessionStore();
    let ids: { user_id?: string; team_id?: string; agent_id?: string; task_id?: string; user_key?: string } | undefined;
    let source = "codebuddy";
    for (const key of [`codebuddy:${sid}`, `claude-code:${sid}`, `workbuddy:${sid}`, sid]) {
      const state = store.get(key);
      if (state?.status === "initialized" && !state.bypassed && state.sessionInfo?.space_id === space) {
        ids = state.sessionInfo; source = key.includes(":") ? key.split(":")[0] : "codebuddy"; break;
      }
    }
    if (!ids) {
      const binding = await store.getBindingRepo()?.getBinding(space, sid);
      if (binding?.outcome === "initialized") {
        ids = { user_id: binding.userId, team_id: binding.teamId,
          agent_id: binding.agentId, task_id: binding.taskId, user_key: binding.userKey };
        source = binding.agentSource || "codebuddy";
      }
    }
    if (!ids?.user_key || !ids.user_id || !ids.team_id || !ids.agent_id) return error(401, "session_not_initialized");
    if(benchmarkBinding(ids,ids.user_id)?.arm==="no_team_assets")return error(403,"benchmark_no_team_assets");
    try {
      const client = getMetadataClient(config.coreSkill, space, ids.user_key);
      const history = configuredHistoryStore(config);
      const scope = historyScope({ space, user: ids.user_id, team: ids.team_id,
        agent: ids.agent_id, task: ids.task_id || "", session: sid, source });
      const ledger = history ? await history.read(scope) : undefined;
      if (forgetting) {
        if (!history) return error(404, "asset_history_disabled");
        await history.transaction(scope, async state => {
          const ref = Object.keys(state.references).find(ref => state.references[ref].asset_id === data.asset_id
            && state.references[ref].revision_id === data.revision_id);
          if (!ref) throw new Error("not_in_session_catalogue");
          state.suppressedRefs = [...new Set([...(state.suppressedRefs ?? []), ref])];
          state.liveRefs = state.liveRefs.filter(key => key !== ref);
        });
        return new Response(JSON.stringify({ status: "suppressed_in_this_session", asset_id: data.asset_id,
          revision_id: data.revision_id, asset_deleted: false, audit_deleted: false }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (!listing && ledger?.suppressedRefs?.some(ref => ledger.references[ref]?.asset_id === data.asset_id
          && ledger.references[ref]?.revision_id === data.revision_id)) return error(409, "asset_suppressed_in_this_session");
      const refs = ledger && Date.now() - ledger.updated <= 30 * 86400_000
        ? ledger.liveRefs.map(ref => ledger.references[ref]).filter(Boolean) : [];
      if (listing) {
        if (!history) return error(404, "asset_history_disabled");
        const assets = await client.listAccessibleAssets({ user_id: ids.user_id, team_id: ids.team_id, agent_id: ids.agent_id, action: "use" });
        const query = String(data.query || "").toLocaleLowerCase();
        const matches = refs.filter(ref => assets.some(a => a.asset_id === ref.asset_id
          && (a as any).quality_publication?.revision_id === ref.revision_id)
          && `${ref.name} ${ref.asset_id}`.toLocaleLowerCase().includes(query));
        const offset = Number(data.offset || 0), limit = Number(data.limit || 10);
        const page = matches.slice(offset, offset + limit);
        if (page.length) await client.quality("disclosure-remember", { team_id: ids.team_id, agent_id: ids.agent_id,
          task_id: ids.task_id || "", session_id: sid, references: page.map(({ asset_id, revision_id }) => ({ asset_id, revision_id })) });
        return new Response(JSON.stringify({ items: page.map(({ asset_id, revision_id, name, card }) => ({ asset_id, revision_id, name, card })),
          total: matches.length, next_offset: offset + page.length < matches.length ? offset + page.length : null,
          status: "index_only_not_body_or_usage" }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      }
      // The durable Proxy catalogue can outlive Core's bounded hot manifest.
      // Refresh only a reference actually offered in this same bound session;
      // Core rechecks current ACL/publication on both remember and read.
      if (refs.some(ref => ref.asset_id === data.asset_id && ref.revision_id === data.revision_id)) {
        await client.quality("disclosure-remember", { team_id: ids.team_id, agent_id: ids.agent_id,
          task_id: ids.task_id || "", session_id: sid, references: [{ asset_id: data.asset_id, revision_id: data.revision_id }] });
      }
      const result = await client.quality<{
        asset_id: string; revision_id: string; body: string; body_sha256: string; complete: boolean;
      }>("disclosure-read", { team_id: ids.team_id, agent_id: ids.agent_id, task_id: ids.task_id || "", session_id: sid,
        ...data, request_id: `asset-read-${randomUUID()}`, max_chars: config.injection.teamAssets.readMaxChars ?? 60_000 });
      if (result.asset_id !== data.asset_id || result.revision_id !== data.revision_id || !result.complete
          || typeof result.body !== "string" || bodyHash(result.body) !== result.body_sha256) return error(502, "invalid_asset_body");
      return new Response(renderAssetBody(result.asset_id, result.revision_id, result.body), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    } catch {
      // Do not leak upstream diagnostic text (may contain auth or private data).
      return error(409, "asset_read_unavailable: permission/version/manifest/budget check failed or service unavailable; refresh recommendations, do not assume content was read");
    }
  };
}
