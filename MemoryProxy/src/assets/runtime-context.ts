import type {AgentContext, ContextMessage} from '../injection/types.js';
import {extractUserQueryText} from '../common/user-query-extractor.js';
import {codebuddySummary} from '../common/codebuddy-summary.js';
import {AssetHistoryStore, historyDigest, historyScope} from './history-store.js';

export const runtimeMessageFingerprint = (m: ContextMessage) => historyDigest([m.role,m.blocks]);
export function runtimeTurnAnchor(messages: ContextMessage[]) {
  const normalized: unknown[] = [];
  let anchor = '';
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user' && m.blocks.some(b => b.type === 'text')) {
      const query = extractUserQueryText(m.blocks.filter(b => b.type === 'text').map(b => b.content).join('\n'));
      if (!query) continue;
      normalized.push(['user',query]);
      anchor = historyDigest(['runtime-turn-v2',normalized]);
    } else normalized.push([m.role,m.blocks]);
  }
  return anchor;
}

/** Explicit current-turn recovery input, never extracted from old summaries.
 * This is environment context, not authorization or filesystem verification.
 */
export function confirmedWorkspace(messages: ContextMessage[]): string {
  const user=messages.filter(m=>m.role==='user'&&m.blocks.some(b=>b.type==='text')).at(-1);
  if(!user)return '';
  const query=extractUserQueryText(user.blocks.filter(b=>b.type==='text').map(b=>b.content).join('\n'));
  const match=query.match(/^确认当前工作区[：:]\s*(\/[^\r\n\0]+)(?:\r?\n|$)/);
  const path=match?.[1]?.trim()||'';
  return path.length>1&&path.length<=1000?path:'';
}

/** Durable monotonic turn identities; a shortened history never reuses turn 2.
 * Exact retries/tool loops reuse an anchor. A rewrite allocates a continuation
 * instead of guessing that identical wording means the same old turn.
 */
export async function resolveRuntimeContext(ctx: AgentContext, store: AssetHistoryStore,
  loadFloor?: (session: any) => Promise<number>) {
  const custom = ctx.metadata.custom ?? {}, s = custom.session as any;
  if (ctx.metadata.readOnly || !s?.task_id || !s?.team_id || !s?.agent_id || !s?.session_id
      || !ctx.metadata.spaceId || !ctx.metadata.userId || s.user_id !== ctx.metadata.userId) return;
  const scope = historyScope({space:ctx.metadata.spaceId,user:ctx.metadata.userId,team:s.team_id,agent:s.agent_id,task:s.task_id,session:s.session_id,source:ctx.metadata.agentSource});
  await store.transaction(scope, async state => {
    const owned = new Set(state.entries.map(e => e.content));
    const messages = ctx.messages.filter(m => !(m.role === 'user' && m.blocks.length === 1
      && m.blocks[0].type === 'text' && owned.has(m.blocks[0].content)));
    const anchor = runtimeTurnAnchor(messages);
    if (!anchor) return;
    const floor = state.runtime ? 0 : await loadFloor?.(s) ?? 0;
    const runtime = state.runtime ?? {workspace:'',maxTurn:Math.max(floor,(ctx.metadata.turnSeq ?? 1) - 1),turns:[],recentMessages:[]};
    const known = runtime.turns.find(t => t.anchor === anchor);
    const fingerprints = messages.filter(m => m.role !== 'system').map(runtimeMessageFingerprint);
    const summary = messages.some(m => m.role === 'user' && m.blocks.some(b => b.type === 'text' && codebuddySummary(b.content)));
    const fromClient = typeof custom.workspaceFolder === 'string' ? custom.workspaceFolder.trim() : '';
    const confirmation = confirmedWorkspace(messages);
    const explicit = fromClient || confirmation;
    const continuity = summary || fingerprints.some(f => runtime.recentMessages.includes(f)) || !!known;
    if (explicit) {
      runtime.workspace = explicit; custom.workspaceFolder = explicit;
      custom.workspaceSource = fromClient ? 'client_workspace_envelope' : 'explicit_current_turn_confirmation';
    }
    else if (runtime.workspace && continuity) {
      custom.workspaceFolder = runtime.workspace; custom.workspaceSource = 'durable_session_context';
    }
    // Old installations have a history ledger but no runtime cursor. Seed only
    // from the already-bound task plus exact retained client messages, never
    // from a path invented inside the summary. No global/default workspace.
    if (!explicit && !runtime.workspace && summary && state.entries.length) {
      const task = custom.taskDetail as any;
      const path = typeof task?.sourceUrl === 'string' ? task.sourceUrl : '';
      const {messageFingerprint} = await import('./history.js');
      const retained = ctx.messages.filter(m => ['assistant','tool'].includes(m.role))
        .filter(m => state.lastMessages.includes(messageFingerprint(m))).length;
      // A fully compacted legacy request can retain zero original messages.
      // Recover only a workspace already bound to this authenticated task and
      // also explicitly named in the recognized client summary. This is a
      // recovered task binding, NOT a fresh filesystem/environment assertion.
      const confirmedInSummary = messages.some(m => m.role === 'user' && m.blocks.some(b => {
        const envelope=b.type==='text'?codebuddySummary(b.content):undefined;
        return !!path && !!envelope && envelope.summary.includes(path);
      }));
      if (path.startsWith('/') && task?.sourceType === 'other' && (retained >= 2 || confirmedInSummary)) {
        runtime.workspace = path; custom.workspaceFolder = path;
        custom.workspaceSource = retained >= 2 ? 'bound_task_and_verified_retained_history' : 'bound_task_confirmed_in_client_summary';
      }
    }
    const seq = known?.seq ?? Math.max(runtime.maxTurn + 1,ctx.metadata.turnSeq ?? 1);
    if (!known) runtime.turns.push({anchor,seq});
    runtime.turns = runtime.turns.slice(-256);
    runtime.maxTurn = Math.max(runtime.maxTurn,seq);
    runtime.recentMessages = fingerprints.slice(-128);
    state.runtime = runtime;
    if (!custom.workspaceFolder) {
      const task=custom.taskDetail as any;
      const texts=messages.filter(m=>m.role==='user').flatMap(m=>m.blocks.filter(b=>b.type==='text').map(b=>b.content));
      console.warn('[asset-runtime] workspace unresolved',JSON.stringify({summary,history_entries:state.entries.length,
        bound_path:typeof task?.sourceUrl==='string',source_type:task?.sourceType,
        summary_tag:texts.some(t=>t.includes('<cb_summary>')),bound_path_in_input:!!task?.sourceUrl&&texts.some(t=>t.includes(task.sourceUrl)),
        envelope_tags:texts.map(t=>(t.match(/<\/?[a-z_]+/g)||[]).slice(0,8))}));
    }
    ctx.metadata.turnSeq = seq; ctx.metadata.custom = custom;
    if (ctx.metadata.assetDelivery) ctx.metadata.assetDelivery.turnSeq = seq;
  });
}
