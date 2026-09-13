import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createAssetBridgeHandler } from "../asset-bridge.js";
import { bodyHash, renderAssetBody } from "../disclosure.js";
import { getSessionStore } from "../../session/store.js";

const mocked = vi.hoisted(() => ({ quality: vi.fn(), client: vi.fn() }));
vi.mock("../../meta/client.js", () => ({ getMetadataClient: (...args: unknown[]) => { mocked.client(...args); return { quality: mocked.quality }; } }));
const config: any = { injection: { enabled: true, teamAssets: { enabled: true, progressiveDisclosure: true, readMaxChars: 60000 } },
  coreSkill: { endpoint: "http://core", serviceToken: "server-only-secret", timeoutMs: 1000 } };
const headers = { "content-type": "application/json", "x-tdai-service-id": "space", "x-conversation-id": "read-session" };
const ref = { asset_id: "asset", revision_id: "revision" };
function app() { const app = new Hono(); app.all("/asset-bridge/*", createAssetBridgeHandler(config)); return app; }
beforeEach(async () => {
  vi.clearAllMocks();
  mocked.quality.mockResolvedValue({ ...ref, body: "complete body", complete: true, body_sha256: bodyHash("complete body") });
  await getSessionStore().set("codebuddy:read-session", { status: "initialized", keyId: "codebuddy:read-session", startedAt: Date.now(), attemptCount: 0,
    sessionInfo: { session_id: "read-session", space_id: "space", user_id: "user", user_key: "private-business-key", team_id: "team", agent_id: "agent", task_id: "task" } as any });
});
afterEach(() => vi.restoreAllMocks());

describe("versioned asset read bridge", () => {
  it("uses session identity and keeps credentials out of the response", async () => {
    const res = await app().request("/asset-bridge/read", { method: "POST", headers, body: JSON.stringify(ref) });
    expect(res.status).toBe(200); expect(await res.text()).toBe(renderAssetBody("asset", "revision", "complete body"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocked.quality).toHaveBeenCalledWith("disclosure-read", expect.objectContaining({ ...ref, team_id: "team", agent_id: "agent", task_id: "task", session_id: "read-session" }));
    expect(mocked.client.mock.calls[0][2]).toBe("private-business-key");
  });
  it("does not let a request spoof user, task, or an external content URL", async () => {
    for (const field of ["user_id", "task_id", "team_id", "url"]) {
      const res = await app().request("/asset-bridge/read", { method: "POST", headers, body: JSON.stringify({ ...ref, [field]: "other" }) });
      expect(res.status).toBe(400);
    }
    expect(mocked.quality).not.toHaveBeenCalled();
  });
  it("does not use a same-ID L1 session from a different space", async () => {
    const res = await app().request("/asset-bridge/read", { method: "POST", headers: { ...headers, "x-tdai-service-id": "other-space" }, body: JSON.stringify(ref) });
    expect(res.status).toBe(401); expect(mocked.quality).not.toHaveBeenCalled();
  });
  it("recovers identity from persisted binding after the L1 session is absent", async () => {
    vi.spyOn(getSessionStore(), "getBindingRepo").mockReturnValue({ getBinding: vi.fn(async (space, sid) =>
      space === "space" && sid === "recovered" ? { outcome: "initialized", userId: "user", userKey: "recovered-key", teamId: "team", agentId: "agent", taskId: "task" } : null) } as any);
    const res = await app().request("/asset-bridge/read", { method: "POST", headers: { ...headers, "x-conversation-id": "recovered" }, body: JSON.stringify(ref) });
    expect(res.status).toBe(200); expect(mocked.client.mock.calls[0][2]).toBe("recovered-key");
  });
  it("fails closed when the returned version/hash differs or Core rejects the request", async () => {
    for (const result of [{ ...ref, revision_id: "new", body: "complete body", complete: true, body_sha256: bodyHash("complete body") },
      { ...ref, body: "half", complete: true, body_sha256: bodyHash("complete body") }]) {
      mocked.quality.mockResolvedValueOnce(result);
      expect((await app().request("/asset-bridge/read", { method: "POST", headers, body: JSON.stringify(ref) })).status).toBe(502);
    }
    mocked.quality.mockRejectedValueOnce(new Error("private upstream details"));
    const failed = await app().request("/asset-bridge/read", { method: "POST", headers, body: JSON.stringify(ref) });
    expect(failed.status).toBe(409); expect(await failed.text()).not.toContain("private upstream details");
  });
  it("bounds body size and rejects other paths/methods", async () => {
    expect((await app().request("/asset-bridge/read", { method: "POST", headers, body: "x".repeat(4100) })).status).toBe(413);
    expect((await app().request("/asset-bridge/read", { method: "GET", headers })).status).toBe(404);
    expect((await app().request("/asset-bridge/write", { method: "POST", headers, body: JSON.stringify(ref) })).status).toBe(404);
  });
});
