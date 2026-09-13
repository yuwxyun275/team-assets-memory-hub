import { createHash } from "node:crypto";
import { renderDisclosure, visibleTexts, hasAssetBody, estimateDisclosureTokens, referenceKey, type PublishedAsset } from "../../assets/disclosure.js";
import { extractUserQueryText } from "../../common/user-query-extractor.js";
import { qualityEvents, qualityScene, type QualityScene } from "./quality-observer.js";
import { deliverQuality } from "./quality-outbox.js";
import { getMetadataClient, type AccessibleAssetItem } from "../../meta/client.js";
import type { CoreSkillConfig } from "../../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import {
  HOOK_PRIORITY,
  type AgentContext,
  type ContextBlock,
  type ContextMessage,
  type InjectionHook,
} from "../types.js";
import {
  extractTeamAssetObservations,
  stableTurnEvidenceTrace,
} from "./team-assets-evidence-observer.js";

export interface TeamAssetsOrchestratorInjectorConfig {
  endpoint: string;
  externalUrl: string;
  serviceToken: string;
  timeoutMs: number;
  tokenBudget: number;
  maxAssets: number;
  repository: string;
  version: string;
  taskType: string;
  targetPaths: string[];
  progressiveDisclosure?: boolean;
  inlineMaxChars?: number;
  bridgeBaseUrl?: string;
}

interface SelectedAsset {
  asset: { asset_id: string; runtime_asset_id?: string };
}

interface ContextPackage {
  trace_id: string;
  markdown: string;
  token_cost: number;
  selected: SelectedAsset[];
}

interface TaskDetail {
  id?: string;
  name?: string;
  description?: string;
  goal?: string;
  sourceUrl?: string;
  sourceType?: string;
  metadataJson?: string;
}

/**
 * Injects a permission-filtered, token-budgeted multi-source team context.
 *
 * The orchestrator owns ranking and the evidence ledger. MemoryProxy remains
 * the protocol/session boundary and never forwards the user's sk-mem key to
 * the orchestrator or upstream model.
 */
export class TeamAssetsOrchestratorInjector implements InjectionHook {
  id = "team-assets-orchestrator-injector";
  point = "context.tail" as const;
  anchor = undefined;
  priority = HOOK_PRIORITY.MEMORY + 40;
  description = "Inject minimal multi-source team assets with auditable IDs.";
  cacheStrategy = "none" as const;

  constructor(
    private readonly config: TeamAssetsOrchestratorInjectorConfig,
    private readonly coreSkill?: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "timeoutMs">,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const custom = ctx.metadata.custom as Record<string, unknown> | undefined;
    const session = custom?.session as {
      session_id?: string;
      team_id?: string;
      task_id?: string;
      agent_id?: string;
      user_id?: string;
    } | undefined;
    const taskDetail = custom?.taskDetail as TaskDetail | null | undefined;
    const userKey = typeof custom?.userKey === "string" ? custom.userKey : "";
    const workspaceFolder = typeof custom?.workspaceFolder === "string" ? custom.workspaceFolder : "";
    // Proxy replay cards are not human turns or independent usage evidence.
    const clientMessages = (custom?.assetHistoryClientMessages as ContextMessage[] | undefined) ?? ctx.messages;
    const lastUser = getLastUserMessage({ ...ctx, messages: clientMessages });
    const rawQuery = lastUser ? extractUserQueryText(getMessageText(lastUser)) : "";
    const query = isSessionInitArtifact(rawQuery) ? "" : rawQuery;
    const boardDescription = [taskDetail?.description, taskDetail?.goal]
      .filter((item, index, values): item is string => Boolean(item) && values.indexOf(item) === index)
      .join("\n");
    const effectiveDescription = [
      boardDescription,
      query ? `当前 CodeBuddy 请求：${query}` : "",
    ].filter(Boolean).join("\n");
    if (!session?.session_id || !session.team_id || !session.agent_id || !effectiveDescription) return [];
    const retrievalQuery = query || boardDescription;
    // Greetings and questions about the UI/answer format are control turns,
    // not coding scenes. Recommending the same engineering assets here creates
    // noisy negative examples and makes the timeline look indiscriminate.
    if (query && shouldSkipTeamAssetRetrieval(query)) return [];
    const prior = extractTeamAssetObservations(recentRetrievalWindow(clientMessages));
    const before = qualityScene({ requestId: stableTurnEvidenceTrace(session.session_id, Math.max(1, ctx.metadata.turnSeq ?? 1)),
      turn: Math.max(1, ctx.metadata.turnSeq ?? 1), query: retrievalQuery, task: boardDescription,
      messages: recentRetrievalWindow(clientMessages),
      activePaths: [...new Set(prior.tool_calls.flatMap(t => [t.target, ...t.changed_paths]).filter(Boolean))],
      errors: prior.tool_results.filter(r => !r.success).map(r => r.summary).filter(Boolean) });
    const qualityScenes: Record<string, QualityScene> = {};

    // Permission truth comes from MemoryCore using this request's authenticated
    // business key. Only the already-filtered descriptors cross into the local
    // ranker; the key itself never leaves MemoryProxy and never reaches the LLM.
    let accessibleAssets: Record<string, unknown>[] = [];
    if (this.coreSkill && userKey && ctx.metadata.spaceId) {
      try {
        const client = getMetadataClient(this.coreSkill, ctx.metadata.spaceId, userKey);
        const items = (custom?.assetHistoryAccessibleAssets as AccessibleAssetItem[] | undefined) ?? await client.listAccessibleAssets({
          user_id: session.user_id || ctx.metadata.userId || "",
          team_id: session.team_id,
          agent_id: session.agent_id,
          action: "use",
        });
        accessibleAssets = items.map(sanitizeAccessibleAsset);
        if (this.config.progressiveDisclosure) {
          const catalogue = await client.quality<{ references: { asset_id: string; revision_id: string; before?: QualityScene }[] }>("disclosure-list", {
            team_id: session.team_id, agent_id: session.agent_id, task_id: session.task_id || "", session_id: session.session_id });
          for (const ref of catalogue.references) if (ref.before) qualityScenes[referenceKey(ref.asset_id, ref.revision_id)] = ref.before;
        }
        try { await deliverQuality(this.coreSkill, ctx.metadata.spaceId, userKey, "window", { team: session.team_id, task: session.task_id ?? "", session: session.session_id, events: qualityEvents(clientMessages) }); }
        catch { console.warn("[quality] prior observation pending; next request may retry"); }
        const utilityContext = qualityUsageContext(workspaceFolder, session.task_id ?? session.session_id, this.config);
        await Promise.all(accessibleAssets.map(async item => {
          const publication = item.quality_publication as any;
          if (!publication) return;
          // Pilot weights remain frozen; asynchronous observations are still retained separately.
          if(custom?.assetBenchmark && !(custom.assetBenchmark as import("../../assets/benchmark.js").BenchRun).learn_utility){item.quality_utility={score:null,applicability_penalty:0};return;}
          try {
            item.quality_utility = await client.quality("utility", { team_id: session.team_id, asset_id: item.asset_id, revision_id: publication.revision_id, context: utilityContext, before });
          } catch { /* unavailable feedback is neutral, never a reason to bypass a publication gate */ }
        }));
      } catch (error) {
        console.warn(
          `[team-assets] ACL snapshot unavailable for session=${session.session_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // One human turn can contain several model/tool requests. turnSeq stays
    // stable inside that loop, then changes on the next human message.
    const turnSeq = Math.max(1, ctx.metadata.turnSeq ?? 1);
    const evidenceTraceId = stableTurnEvidenceTrace(session.session_id, turnSeq);
    // A request contains the whole conversation history. Evidence must only be
    // attributed to the current human turn; otherwise an old tool call would
    // be copied into every later turn and corrupt feedback learning.
    const observations = extractTeamAssetObservations(currentHumanTurn(clientMessages));
    // Ranking may use the immediately preceding turn's sanitized paths/errors
    // as scene context, while evidence attribution remains restricted to the
    // current human turn above.  This prevents old edits from being claimed as
    // new evidence but lets round N+1 recommend assets relevant to round N's
    // actual code location and failure.
    const retrievalObservations = extractTeamAssetObservations(recentRetrievalWindow(clientMessages));
    const activePaths = [...new Set(retrievalObservations.tool_calls.flatMap((item) => [
      item.target,
      ...item.changed_paths,
    ]).filter(Boolean))].slice(-12);
    const errors = retrievalObservations.tool_results
      .filter((item) => !item.success)
      .map((item) => item.summary)
      .filter(Boolean)
      .slice(-6);
    const observedTests = [...new Set([
      ...retrievalObservations.tool_calls.flatMap((item) => item.test_ids),
      ...retrievalObservations.tool_results.flatMap((item) => item.test_ids),
    ].filter(Boolean))].slice(-80);
    const testPaths = [...new Set(retrievalObservations.tool_calls
      .filter((item) => item.kind === "test")
      .map((item) => item.target)
      .filter(Boolean))].slice(-80);
    const frameworks = [...new Set(retrievalObservations.tool_calls
      .filter((item) => item.kind === "test")
      .flatMap((item) => {
        const value = `${item.name} ${item.command}`.toLowerCase();
        return [
          /pytest/.test(value) ? "pytest" : "",
          /(?:^|\s)(?:npm|pnpm|yarn).*test|jest|vitest/.test(value) ? "javascript-test" : "",
          /go\s+test/.test(value) ? "go-test" : "",
          /mvn|gradle|junit/.test(value) ? "junit" : "",
        ].filter(Boolean);
      }))];

    const progressive = Boolean(this.config.progressiveDisclosure);
    const benchmark=custom?.assetBenchmark as import("../../assets/benchmark.js").BenchRun|undefined;
    const response = await this.post<ContextPackage>("/v2/turns/recommend", {
      strategy: "minimal",
      session_id: session.session_id,
      turn_seq: turnSeq,
      turn_id: evidenceTraceId.replace(/^trace-team-assets-/, ""),
      external_url: this.config.externalUrl,
      auto_profile: true,
      current_query: retrievalQuery,
      budget_ceiling: this.config.tokenBudget,
      max_assets_ceiling: this.config.maxAssets,
      progressive_disclosure: progressive,
      // The new reader serves reviewed immutable units only. Personal/native
      // assets retain their separate pre-existing skill/knowledge injectors.
      accessible_assets: progressive ? accessibleAssets.filter(a => a.quality_publication) : accessibleAssets,
      fallbacks: {
        repository: benchmark?.repository ?? this.config.repository,
        version: benchmark?.version ?? this.config.version,
        task_type: benchmark ? "bug_fix" : this.config.taskType,
        target_paths: benchmark ? ["service.py"] : this.config.targetPaths,
      },
      turn_context: {
        active_paths: activePaths,
        errors,
        recent_summary: retrievalQuery,
      },
      // Only structured, redacted repository facts cross the proxy boundary.
      // Source code and full tool output are intentionally excluded.
      repository_context: {
        workspace_root: workspaceFolder,
        task_source_url: taskDetail?.sourceUrl ?? "",
        active_paths: activePaths,
        target_paths: this.config.targetPaths,
        test_ids: observedTests,
        test_paths: testPaths,
        frameworks,
      },
      task: {
        ...(session.task_id ? { task_id: session.task_id } : {}),
        team_id: session.team_id,
        agent_id: session.agent_id,
        title: taskDetail?.name || (session.task_id ? `CodeBuddy task ${session.task_id}` : `CodeBuddy 第 ${turnSeq} 轮任务`),
        description: effectiveDescription,
        source_url: taskDetail?.sourceUrl ?? "",
        source_type: taskDetail?.sourceType ?? "",
      },
      task_detail: {
        task_id: taskDetail?.id ?? session.task_id ?? "",
        title: taskDetail?.name ?? "",
        description: taskDetail?.description ?? "",
        source_url: taskDetail?.sourceUrl ?? "",
        source_type: taskDetail?.sourceType ?? "",
        metadata_json: taskDetail?.metadataJson ?? "",
      },
    });
    if (!response?.markdown) return [];

    // The request already contains prior assistant/tool messages. Extract only
    // a redacted, structured observation; never forward full conversation text
    // or the user's business key to the evidence service.
    if (
      observations.declarations.length > 0
      || observations.feedback.length > 0
      || observations.acceptance_declarations.length > 0
      || observations.codebuddy_acceptance_plan !== null
      || observations.tool_calls.length > 0
      || observations.tool_results.length > 0
    ) {
      await this.post<Record<string, unknown>>("/v1/evidence/observe", {
        trace_id: response.trace_id,
        task_id: session.task_id ?? "",
        actor_id: session.agent_id,
        workspace_root: workspaceFolder,
        ...observations,
      });
    }
    for (const feedback of observations.feedback) {
      await this.post<Record<string, unknown>>("/v2/turns/feedback", {
        trace_id: response.trace_id,
        actor_id: session.agent_id,
        actor_type: "agent",
        ...feedback,
      });
    }
    if (progressive) {
      if (!this.coreSkill || !userKey || !ctx.metadata.spaceId || !this.config.bridgeBaseUrl) return [];
      const selected = accessibleAssets.filter(a => a.quality_publication && response.selected.some(s =>
        (s.asset.runtime_asset_id ?? s.asset.asset_id) === a.asset_id)) as unknown as PublishedAsset[];
      const client = getMetadataClient(this.coreSkill, ctx.metadata.spaceId, userKey);
      // Await persistence before advertising a pointer. Fail closed for asset
      // content if the catalogue cannot be saved; ordinary conversation continues.
      const saved = await client.quality<{ references: { asset_id: string; revision_id: string; before?: QualityScene }[] }>("disclosure-remember", {
        team_id: session.team_id, agent_id: session.agent_id, task_id: session.task_id || "", session_id: session.session_id,
        references: selected.map(a => ({ asset_id: a.asset_id, revision_id: a.quality_publication.revision_id })),
        before,
      });
      for (const ref of saved.references) if (ref.before) qualityScenes[referenceKey(ref.asset_id, ref.revision_id)] = ref.before;
      const accepted = selected.filter(a => saved.references.some(r => r.asset_id === a.asset_id && r.revision_id === a.quality_publication.revision_id));
      // A renamed asset is still the same immutable revision. History checks
      // complete persisted card text, not a bare ID in a compressed summary.
      const visibleCardKeys = new Set((ctx.metadata.custom?.assetHistoryVisibleCardKeys as string[] | undefined) ?? []);
      const existingCards = accepted.filter(a => visibleCardKeys.has(referenceKey(a.asset_id, a.quality_publication.revision_id)));
      const rendered = renderDisclosure({ assets: accepted.filter(a => !visibleCardKeys.has(referenceKey(a.asset_id, a.quality_publication.revision_id))), messages: ctx.messages,
        bridgeBaseUrl: this.config.bridgeBaseUrl, spaceId: ctx.metadata.spaceId, sessionId: session.session_id,
        tokenBudget: this.config.tokenBudget, inlineMaxChars: this.config.inlineMaxChars ?? 600 });
      // Keep existing acceptance/repository guidance, but not the old full-body
      // team_assets block. Deduplicate exact guidance without rewriting history.
      const guidance = response.markdown.replace(/<team_assets>[\s\S]*?<\/team_assets>/g, "").trim();
      const texts = visibleTexts(ctx.messages);
      const guidanceFits = estimateDisclosureTokens([rendered.content, guidance].join("\n\n")) <= this.config.tokenBudget;
      const content = [rendered.content, guidance && guidanceFits && !texts.some(t => t.includes(guidance)) ? guidance : ""].filter(Boolean).join("\n\n");
      const observed = accessibleAssets.filter(a => a.quality_publication && hasAssetBody(texts, a as unknown as PublishedAsset));
      const exposed = [...new Map([...observed, ...rendered.bodies].map(a => [a.asset_id, a])).values()];
      return [{ type: content ? "text" : "custom", content, metadata: {
        source: this.id, traceId: response.trace_id, progressiveDisclosure: true,
        assetIds: [...new Set([...rendered.bodies, ...observed].map(a => a.asset_id))], qualityAssets: exposed,
        cardAssetIds: [...existingCards, ...rendered.cards].map(a => a.asset_id), omittedAssetIds: rendered.omitted,
        tokenCost: estimateDisclosureTokens(content),
        qualityBaseline: qualityEvents(clientMessages).map(e => e.id).slice(-4000),
        qualityScene: before, qualityScenes,
      } }];
    }
    return [{
      type: "text",
      content: response.markdown,
      metadata: {
        source: this.id,
        traceId: response.trace_id,
        assetIds: response.selected.map((item) => item.asset.asset_id),
        tokenCost: response.token_cost,
        qualityAssets: accessibleAssets.filter(a => response.selected.some(s => (s.asset.runtime_asset_id ?? s.asset.asset_id) === a.asset_id) && a.quality_publication),
        qualityBaseline: qualityEvents(clientMessages).map(e => e.id).slice(-4000),
        qualityScene: before, qualityScenes,
      },
    }];
  }

  async onApplied(ctx: AgentContext, blocks: ContextBlock[]): Promise<void> {
    const block = blocks.find((item) => item.metadata?.source === this.id);
    if (!block) return;
    const traceId = String(block.metadata?.traceId ?? "");
    const requestedIds = Array.isArray(block.metadata?.assetIds)
      ? block.metadata.assetIds.map(String).filter(Boolean)
      : [];
    const texts = visibleTexts(ctx.messages);
    const deliveredAssets = ((block.metadata?.qualityAssets ?? []) as any[]).filter(asset => {
      const body = asset.quality_publication?.snapshot?.body;
      return typeof body === 'string' && body.length > 0 && (block.metadata?.progressiveDisclosure
        ? hasAssetBody(texts, asset) : texts.some(t => t.includes(body)));
    });
    const assetIds = requestedIds.filter(id => block.metadata?.progressiveDisclosure
      ? deliveredAssets.some(a => a.asset_id === id)
      : !!block.content && texts.some(t => t.includes(block.content)));
    if (!traceId) return;
    const custom = ctx.metadata.custom as any;
    const session = custom?.session;
    if (this.coreSkill && custom?.userKey && ctx.metadata.spaceId && session?.task_id) {
      for (const asset of deliveredAssets) {
        const publication = asset.quality_publication;
        // Only mark content which is actually present after pipeline application.
        if (!publication?.snapshot?.body) continue;
        try {
          await deliverQuality(this.coreSkill, ctx.metadata.spaceId, custom.userKey, "expose", { team_id: session.team_id, exposure: {
            asset_id: asset.asset_id, revision_id: publication.revision_id, task_id: session.task_id,
            session_id: session.session_id, turn: Math.max(1, ctx.metadata.turnSeq ?? 1),
            context: qualityUsageContext(custom.workspaceFolder || '', session.task_id, this.config),
            injected_text: publication.snapshot.body, request_id: traceId,
            baseline_event_ids: block.metadata?.qualityBaseline ?? [],
            before: (block.metadata?.qualityScenes as Record<string, QualityScene> | undefined)?.[referenceKey(asset.asset_id, publication.revision_id)]
              ?? block.metadata?.qualityScene,
          } });
        } catch { console.warn("[quality] injection observation not acknowledged; no effect credit will be inferred"); }
      }
    }
    if (assetIds.length === 0) return;
    const contextHash = `sha256:${createHash("sha256")
      .update(blocks.map((item) => item.content).join("\n"))
      .digest("hex")}`;
    await this.post<Record<string, unknown>>("/v1/evidence/injected", {
      trace_id: traceId,
      asset_ids: assetIds,
      context_hash: contextHash,
      protocol: ctx.metadata.protocol,
      injection_point: this.point,
      request_trace_id: ctx.metadata.traceId,
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    const serialized = JSON.stringify(body);
    const idempotencyKey = createHash("sha256")
      .update(`${path}\0${serialized}`)
      .digest("hex");
    const endpoint = `${this.config.endpoint.replace(/\/$/, "")}${path}`;
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-idempotency-key": idempotencyKey,
            ...(this.config.serviceToken ? { authorization: `Bearer ${this.config.serviceToken}` } : {}),
          },
          body: serialized,
          signal: controller.signal,
        });
        if (response.ok) return await response.json() as T;
        // Retry only transient pressure/outage responses. A contract/auth 4xx
        // should fail open immediately instead of amplifying bad requests.
        if (response.status !== 429 && response.status < 500) return null;
      } catch {
        // A network timeout is transient and may be retried with the same
        // idempotency key. The orchestrator ledger de-duplicates each state.
      } finally {
        clearTimeout(timer);
      }
      if (attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
      }
    }
    // Fail open: an evidence sidecar outage must not block the upstream model.
    return null;
  }
}

/** Unknown environment is task-local, never pooled as a single universal empty-string context. */
export function qualityUsageContext(workspace: string, taskId: string, config: Pick<TeamAssetsOrchestratorInjectorConfig, 'repository' | 'taskType' | 'version'>) {
  const unknown = `task-local:${taskId}`;
  return { repository: workspace || config.repository || unknown,
    task_type: config.taskType || unknown, environment: config.version || unknown };
}

const ACCESSIBLE_ASSET_FIELDS = [
  "asset_id", "team_id", "asset_type", "name", "description", "owner_user_id",
  "visibility", "status", "version", "created_at", "updated_at", "source_ref", "source_type",
  "content_ref", "metadata_json", "confidence", "expires_at",
  "quality_publication", "quality_utility",
] as const;

export function sanitizeAccessibleAsset(item: AccessibleAssetItem & Record<string, any>): Record<string, unknown> {
  const sanitized=Object.fromEntries(
    ACCESSIBLE_ASSET_FIELDS
      .filter((key) => item[key] !== undefined && item[key] !== null)
      .map((key) => [key, item[key]]),
  );
  if(item.quality_publication){
    const p=item.quality_publication,s=p.snapshot??{},r=p.report??{};
    // The ranker needs content and gate outcomes, not hundreds of repeated source
    // excerpts in review reports. Full evidence remains in Core for audit/read.
    sanitized.quality_publication={revision_id:p.revision_id,expected_version:p.expected_version,approved_by:p.approved_by,approved_at:p.approved_at,
      snapshot:{asset_id:s.asset_id,unit_id:s.unit_id,asset_type:s.asset_type,content_version:s.content_version,declared_scope:s.declared_scope,project_scope:s.project_scope,workflow_scope:s.workflow_scope,body:s.body},
      report:{decision:r.decision,snapshot_sha256:r.snapshot_sha256,scorecard:{quality:r.scorecard?.quality,evidence_coverage:r.scorecard?.evidence_coverage}}};
  }
  return sanitized;
}

function isSessionInitArtifact(text: string): boolean {
  const value = text.trim();
  return value.startsWith("<question_answer>")
    || /"type"\s*:\s*"multi_question_result"/.test(value)
    || value.startsWith("User has answered your questions:");
}

export function currentHumanTurn(messages: ContextMessage[]): ContextMessage[] {
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      start = index;
      break;
    }
  }
  return start >= 0 ? messages.slice(start) : messages;
}

/** The previous and current human turns, used only for redacted retrieval hints. */
export function recentRetrievalWindow(messages: ContextMessage[]): ContextMessage[] {
  const userIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") userIndexes.push(index);
  }
  if (userIndexes.length === 0) return messages.slice(-12);
  const start = userIndexes[Math.max(0, userIndexes.length - 2)] ?? 0;
  return messages.slice(start);
}

export function shouldSkipTeamAssetRetrieval(query: string): boolean {
  const value = query.trim().toLowerCase();
  if (!value) return true;
  if (/^(你好|您好|嗨|哈喽|hello|hi|hey)[！!。.\s]*$/.test(value)) return true;
  return /乱码|机器可读.{0,8}(标签|json)|回答.{0,8}(乱码|格式)|输出格式|为什么.{0,8}(回答|显示).{0,8}(乱码|奇怪)/i.test(value);
}
