import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../../../types.js";
import { stableTurnEvidenceTrace } from "../team-assets-evidence-observer.js";
import { observeTeamAssetAssistantResponse } from "../team-assets-response-observer.js";

function config(): ProxyConfig {
  return {
    injection: {
      enabled: true,
      teamAssets: {
        enabled: true,
        endpoint: "http://orchestrator",
        externalUrl: "http://agent-visible",
        serviceToken: "service-token",
        timeoutMs: 1000,
        tokenBudget: 760,
        maxAssets: 4,
        repository: "",
        version: "",
        taskType: "",
        targetPaths: [],
      },
    },
  } as unknown as ProxyConfig;
}

afterEach(() => vi.unstubAllGlobals());

describe("team asset response observer", () => {
  it("flushes final declarations without waiting for another user request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await observeTeamAssetAssistantResponse(config(), {
      sessionId: "session-final-response",
      turnSeq: 2,
      actorId: "agent-backend",
      text: '<team_asset_use>{"asset_id":"asset-wiki","decision":"保持租户隔离","target":"feature_flags/service.py"}</team_asset_use>',
      toolCalls: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://orchestrator/v1/evidence/observe");
    const body = JSON.parse(String(options.body));
    expect(body.trace_id).toBe(stableTurnEvidenceTrace("session-final-response", 2));
    expect(body.observation_boundary).toBe("assistant_response_complete");
    expect(body.declarations[0].asset_id).toBe("asset-wiki");
    expect(String((options.headers as Record<string, string>).authorization)).toBe("Bearer service-token");
  });

  it("does not send ordinary assistant prose", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await observeTeamAssetAssistantResponse(config(), {
      sessionId: "session-no-evidence",
      turnSeq: 1,
      actorId: "agent-backend",
      text: "任务已经完成。",
      toolCalls: [],
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
