import { describe, expect, it, vi } from "vitest";
import type * as http from "node:http";
import { handleV3MetaRoute } from "../../metadata/router/v3-meta-router.js";
import { snapshot } from "./fixtures.js";
import { MetadataError, type MetadataService } from "../../metadata/service/metadata-service.js";
import { logMetaApiEntry, logMetaApiResponse } from "../../metadata/router/meta-api-trace.js";

vi.mock("../../metadata/router/auth.js", async (original) => ({
  ...await original<typeof import("../../metadata/router/auth.js")>(),
  authenticateV3: vi.fn(async () => ({ ok: true, ctx: { userId: "owner", token: "test", isAdmin: false, isSystemAdmin: false } })),
}));
// Isolate HTTP dispatch from optional production observability/database dependencies.
vi.mock("../../gateway/v2-router.js", () => ({
  successEnvelope: (data: unknown, requestId: string) => ({ code: 0, message: "ok", data, requestId }),
  errorEnvelope: (code: number, message: string, requestId: string) => ({ code, message, data: null, requestId }),
  resolveRequestId: () => "test-request",
}));
vi.mock("../../gateway/v2-schemas.js", () => ({ formatZodError: () => "invalid input" }));
vi.mock("../../metadata/router/meta-api-trace.js", () => ({
  createMetaApiTraceContext: (args: unknown) => ({ ...args as object }),
  logMetaApiEntry: vi.fn(), logMetaApiResponse: vi.fn(), logMetaApiError: vi.fn(), logMetaApiRejected: vi.fn(),
}));

async function call(body: unknown, handler = vi.fn(async () => ({ decision: "needs_evidence", checks: [{ reason: "private-report" }] })), authorized = true) {
  const send = vi.fn();
  const req = { headers: { "x-tdai-service-id": "default", ...(authorized ? { "x-tdai-user-key": "test-key" } : {}) } } as unknown as http.IncomingMessage;
  await handleV3MetaRoute(req, {} as http.ServerResponse, "/v3/meta/asset/quality/evaluate", "POST", async () => body as any, send, {
    getMetadataService: () => ({ evaluateAssetQualityForCaller: handler } as unknown as MetadataService),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { send, handler };
}

describe("quality evaluation HTTP route", () => {
  it.each(['task-receipt', 'failed-uses', 'retry-use'])('dispatches authenticated usage action %s', async action => {
    const send = vi.fn(), qualityForCaller = vi.fn(async () => ({ items: [] }));
    await handleV3MetaRoute({ headers: { 'x-tdai-service-id': 'default', 'x-tdai-user-key': 'test-key' } } as any,
      {} as http.ServerResponse, `/v3/meta/asset/quality/${action}`, 'POST', async () => ({ team_id: 'team-1' }), send,
      { getMetadataService: () => ({ qualityForCaller } as unknown as MetadataService), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    expect(send.mock.calls[0][1]).toBe(200);
    expect(qualityForCaller).toHaveBeenCalledWith(action, { team_id: 'team-1' }, expect.objectContaining({ userId: 'owner' }));
  });
  it("returns the report while omitting snapshots and quotations from HTTP logs", async () => {
    const s = snapshot(); s.body += " private-body";
    const { send, handler } = await call({ snapshot: s });
    expect(send.mock.calls[0][1]).toBe(200);
    expect(handler).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logMetaApiEntry).mock.calls)).not.toContain("private-body");
    expect(JSON.stringify(vi.mocked(logMetaApiResponse).mock.calls)).not.toContain("private-report");
  });
  it("requires a user key", async () => {
    const { send, handler } = await call({ snapshot: snapshot() }, undefined, false);
    expect(send.mock.calls[0][1]).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
  it("rejects caller supplied model URLs and metadata-only requests", async () => {
    for (const body of [{ asset_id: "asset-1" }, { snapshot: snapshot(), model_url: "http://attacker.invalid" }]) {
      const { send, handler } = await call(body);
      expect(send.mock.calls[0][1]).toBe(400);
      expect(handler).not.toHaveBeenCalled();
    }
  });
  it.each([["quality_version_conflict", 409], ["quality_review_busy", 429], ["permission_denied", 403]] as const)("maps %s to %d", async (code, expected) => {
    const { send } = await call({ snapshot: snapshot() }, vi.fn(async () => { throw new MetadataError(code, "review rejected"); }));
    expect(send.mock.calls[0][1]).toBe(expected);
  });
});
