import { afterEach, describe, expect, it, vi } from "vitest";
import {
  currentHumanTurn,
  recentRetrievalWindow,
  shouldSkipTeamAssetRetrieval,
  TeamAssetsOrchestratorInjector,
  qualityUsageContext,
} from "../team-assets-orchestrator-injector.js";
import type { AgentContext } from "../../types.js";

function context(): AgentContext {
  return {
    messages: [
      { role: "system", blocks: [{ type: "text", content: "system" }] },
      { role: "user", blocks: [{ type: "text", content: "Fix intermittent cache 5xx safely" }] },
    ],
    requestParams: {},
    metadata: {
      protocol: "openai",
      traceId: "trace-1",
      keyId: "key-1",
      modelId: "model",
      stream: false,
      agentSource: "codebuddy",
      custom: {
        session: {
          session_id: "session-team-assets-1",
          team_id: "team-feature-platform",
          agent_id: "agent-new-backend",
          task_id: "task-cache-outage-001",
        },
        taskDetail: {
          id: "task-cache-outage-001",
          name: "任务看板里的缓存故障修复",
          description: "Redis 异常时安全回退并验证租户隔离",
        },
      },
    },
  };
}

describe("TeamAssetsOrchestratorInjector", () => {
  it('does not pool different tasks when repository or environment metadata is missing', () => {
    const empty={repository:'',taskType:'',version:''};
    expect(qualityUsageContext('', 'task-a', empty)).not.toEqual(qualityUsageContext('', 'task-b', empty));
    expect(qualityUsageContext('/repo','task-a',{repository:'fallback',taskType:'bug_fix',version:'v1'}))
      .toEqual({repository:'/repo',task_type:'bug_fix',environment:'v1'});
  });
  it("skips greetings and response-format troubleshooting turns", () => {
    expect(shouldSkipTeamAssetRetrieval("你好")).toBe(true);
    expect(shouldSkipTeamAssetRetrieval("为什么你回答乱码了")).toBe(true);
    expect(shouldSkipTeamAssetRetrieval("请修复 Redis 缓存故障")).toBe(false);
    expect(shouldSkipTeamAssetRetrieval("B")).toBe(false);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("injects selected asset IDs without forwarding a user key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      trace_id: "trace-1",
      markdown: "<team_assets>[asset:asset-wiki]</team_assets>",
      token_cost: 100,
      selected: [{ asset: { asset_id: "asset-wiki" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const injector = new TeamAssetsOrchestratorInjector({
      endpoint: "http://orchestrator",
      externalUrl: "http://agent-visible",
      serviceToken: "service-token",
      timeoutMs: 1000,
      tokenBudget: 760,
      maxAssets: 4,
      repository: "team/repo",
      version: "1.4",
      taskType: "bug_fix",
      targetPaths: ["feature_flags/service.py"],
    });
    const blocks = await injector.execute(context());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].metadata?.assetIds).toEqual(["asset-wiki"]);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://orchestrator/v2/turns/recommend");
    expect(body.session_id).toBe("session-team-assets-1");
    expect(body.turn_seq).toBe(1);
    expect(body.task.team_id).toBe("team-feature-platform");
    expect(body.task.title).toBe("任务看板里的缓存故障修复");
    expect(body.task.description).toContain("Redis 异常时安全回退并验证租户隔离");
    expect(body.auto_profile).toBe(true);
    expect(body.repository_context.target_paths).toEqual(["feature_flags/service.py"]);
    expect(body.repository_context).not.toHaveProperty("source_code");
    expect(JSON.stringify(body)).not.toContain("sk-mem-");
  });

  it("ranks only the current user's MemoryCore ACL snapshot", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/asset/quality/open-exposures")) return new Response(JSON.stringify({ code: 0, data: { items: [] } }), { status: 200 });
      if (String(url).includes("/v3/meta/asset/list-accessible")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            items: [{
              asset_id: "wiki-runtime",
              team_id: "team-feature-platform",
              asset_type: "llm_wiki",
              name: "团队缓存规范",
              description: "Redis 故障时保持租户隔离",
              visibility: "team",
              status: "approved",
            }],
            total: 1,
            limit: 100,
            offset: 0,
          },
        }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      expect(body.accessible_assets).toHaveLength(1);
      expect(body.accessible_assets[0].asset_id).toBe("wiki-runtime");
      expect(JSON.stringify(body)).not.toContain("sk-mem-current-user");
      return new Response(JSON.stringify({
        trace_id: "trace-acl",
        markdown: "<team_assets>[asset:wiki-runtime]</team_assets>",
        token_cost: 80,
        selected: [{ asset: { asset_id: "wiki-runtime" } }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();
    ctx.metadata.spaceId = "default";
    ctx.metadata.userId = "user-current";
    (ctx.metadata.custom as Record<string, unknown>).userKey = "sk-mem-current-user";
    ((ctx.metadata.custom as Record<string, unknown>).session as Record<string, unknown>).user_id = "user-current";
    const injector = new TeamAssetsOrchestratorInjector({
      endpoint: "http://orchestrator",
      externalUrl: "http://agent-visible",
      serviceToken: "orchestrator-token",
      timeoutMs: 1000,
      tokenBudget: 760,
      maxAssets: 4,
      repository: "team/repo",
      version: "1.4",
      taskType: "bug_fix",
      targetPaths: [],
    }, {
      endpoint: "http://memory-core",
      serviceToken: "core-service-token",
      timeoutMs: 1000,
    });

    expect(await injector.execute(ctx)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const coreRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect((coreRequest.headers as Record<string, string>)["x-tdai-user-key"]).toBe("sk-mem-current-user");
  });

  it("uses the task description instead of a session form answer for first-turn retrieval", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      trace_id: "trace-first-real-turn",
      markdown: "<team_assets>[asset:asset-wiki]</team_assets>",
      token_cost: 100,
      selected: [{ asset: { asset_id: "asset-wiki" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();
    ctx.messages[1].blocks[0].content = "<question_answer>体验任务02</question_answer>";
    const injector = new TeamAssetsOrchestratorInjector({
      endpoint: "http://orchestrator",
      externalUrl: "http://agent-visible",
      serviceToken: "",
      timeoutMs: 1000,
      tokenBudget: 760,
      maxAssets: 4,
      repository: "team/repo",
      version: "1.4",
      taskType: "bug_fix",
      targetPaths: [],
    });
    expect(await injector.execute(ctx)).toHaveLength(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.current_query).toBe("Redis 异常时安全回退并验证租户隔离");
  });

  it("retrieves team assets without requiring a task-board item", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      trace_id: "trace-taskless-turn",
      markdown: "<team_assets>[asset:asset-wiki]</team_assets>",
      token_cost: 100,
      selected: [{ asset: { asset_id: "asset-wiki" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const injector = new TeamAssetsOrchestratorInjector({
      endpoint: "http://orchestrator",
      externalUrl: "http://agent-visible",
      serviceToken: "",
      timeoutMs: 1000,
      tokenBudget: 760,
      maxAssets: 4,
      repository: "team/repo",
      version: "1.4",
      taskType: "bug_fix",
      targetPaths: [],
    });
    const ctx = context();
    const session = (ctx.metadata.custom?.session ?? {}) as Record<string, unknown>;
    delete session.task_id;
    ctx.metadata.turnSeq = 5;

    expect(await injector.execute(ctx)).toHaveLength(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.task.task_id).toBeUndefined();
    expect(body.turn_seq).toBe(5);
  });

  it("acknowledges injection only from the pipeline post-apply boundary", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
        trace_id: "trace-asset-chain",
        markdown: "<team_assets>[asset:asset-wiki]</team_assets>",
        token_cost: 100,
        selected: [{ asset: { asset_id: "asset-wiki" } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const injector = new TeamAssetsOrchestratorInjector({
      endpoint: "http://orchestrator",
      externalUrl: "http://agent-visible",
      serviceToken: "",
      timeoutMs: 1000,
      tokenBudget: 760,
      maxAssets: 4,
      repository: "team/repo",
      version: "1.4",
      taskType: "bug_fix",
      targetPaths: [],
    });
    const ctx = context();
    const blocks = await injector.execute(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    ctx.messages.push({role:'user',blocks:blocks.filter(b=>b.type==='text')});
    await injector.onApplied(ctx, blocks);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://orchestrator/v1/evidence/injected");
    const ack = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(ack.asset_ids).toEqual(["asset-wiki"]);
    expect(ack.context_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("fails open when the orchestrator is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const injector = new TeamAssetsOrchestratorInjector({
      endpoint: "http://orchestrator",
      externalUrl: "http://agent-visible",
      serviceToken: "",
      timeoutMs: 10,
      tokenBudget: 760,
      maxAssets: 4,
      repository: "team/repo",
      version: "1.4",
      taskType: "bug_fix",
      targetPaths: [],
    });
    expect(await injector.execute(context())).toEqual([]);
  });

  it("retries a transient outage with a stable idempotency key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "busy" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        trace_id: "trace-recovered",
        markdown: "<team_assets>[asset:asset-wiki]</team_assets>",
        token_cost: 100,
        selected: [{ asset: { asset_id: "asset-wiki" } }],
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const injector = new TeamAssetsOrchestratorInjector({
      endpoint: "http://orchestrator",
      externalUrl: "http://agent-visible",
      serviceToken: "service-token",
      timeoutMs: 1000,
      tokenBudget: 760,
      maxAssets: 4,
      repository: "team/repo",
      version: "1.4",
      taskType: "bug_fix",
      targetPaths: [],
    });
    expect(await injector.execute(context())).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(firstHeaders["x-idempotency-key"]).toMatch(/^[a-f0-9]{64}$/);
    expect(secondHeaders["x-idempotency-key"]).toBe(firstHeaders["x-idempotency-key"]);
  });

  it("does not attribute earlier-turn tool evidence to the current turn", () => {
    const messages: AgentContext["messages"] = [
      { role: "user", blocks: [{ type: "text", content: "第一轮问题" }] },
      { role: "assistant", blocks: [{ type: "tool_use", content: "old-tool" }] },
      { role: "tool", blocks: [{ type: "tool_result", content: "old-result" }] },
      { role: "user", blocks: [{ type: "text", content: "第二轮问题" }] },
      { role: "assistant", blocks: [{ type: "tool_use", content: "new-tool" }] },
    ];

    expect(currentHumanTurn(messages).map((item) => item.role)).toEqual(["user", "assistant"]);
    expect(currentHumanTurn(messages)[1].blocks[0].content).toBe("new-tool");
    expect(recentRetrievalWindow(messages).map((item) => item.role)).toEqual([
      "user", "assistant", "tool", "user", "assistant",
    ]);
  });
});
