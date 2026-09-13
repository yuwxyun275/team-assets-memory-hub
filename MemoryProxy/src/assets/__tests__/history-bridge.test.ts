import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAssetBridgeHandler } from "../asset-bridge.js";
import { AssetHistoryStore, historyScope } from "../history-store.js";
import { getSessionStore } from "../../session/store.js";
import { bodyHash, referenceKey, renderAssetCard } from "../disclosure.js";

const mocks = vi.hoisted(() => ({ list: vi.fn(), quality: vi.fn() }));
vi.mock("../../meta/client.js", () => ({ getMetadataClient: () => ({ listAccessibleAssets: mocks.list, quality: mocks.quality }) }));
const makeAsset = (id: string) => ({ asset_id: id, name: `Redis ${id}`, quality_publication: { revision_id: "r1", snapshot: { body: `body ${id}`, content_version: "1" } } });
const assets = [makeAsset("A"), makeAsset("B"), makeAsset("C")];
const headers = { "content-type": "application/json", "x-tdai-service-id": "space", "x-conversation-id": "history-bridge" };
const scope = historyScope({ space: "space", user: "user", team: "team", agent: "agent", task: "task", session: "history-bridge", source: "codebuddy" });
let config: any, store: AssetHistoryStore, app: Hono;
beforeEach(async () => {
  vi.clearAllMocks();
  const directory = await mkdtemp(join(tmpdir(), "proxy-history-bridge-test-"));
  store = new AssetHistoryStore(directory);
  config = { injection: { enabled: true, teamAssets: { enabled: true, progressiveDisclosure: true, historyEnabled: true, historyDirectory: directory } }, coreSkill: {} };
  await store.transaction(scope, async state => {
    state.updated = Date.now();
    for (const a of assets) state.references[referenceKey(a.asset_id, "r1")] = {
      asset_id: a.asset_id, revision_id: "r1", name: a.name, last_read: 0,
      card: renderAssetCard(a, "http://proxy", "space", "history-bridge"),
    };
    state.liveRefs = [referenceKey("A", "r1"), referenceKey("B", "r1")]; // C was in a retired branch
  });
  await getSessionStore().set("codebuddy:history-bridge", { status: "initialized", keyId: "codebuddy:history-bridge", startedAt: Date.now(), attemptCount: 0,
    sessionInfo: { session_id: "history-bridge", space_id: "space", user_id: "user", user_key: "private", team_id: "team", agent_id: "agent", task_id: "task" } as any });
  mocks.list.mockResolvedValue(assets);
  mocks.quality.mockImplementation(async (action, data) => action === "disclosure-read"
    ? { asset_id: data.asset_id, revision_id: data.revision_id, body: `body ${data.asset_id}`, body_sha256: bodyHash(`body ${data.asset_id}`), complete: true }
    : { references: data.references });
  app = new Hono(); app.all("/asset-bridge/*", createAssetBridgeHandler(config));
});
afterEach(() => vi.restoreAllMocks());
const call = (path: string, data: unknown) => app.request(`/asset-bridge/${path}`, { method: "POST", headers, body: JSON.stringify(data) });

describe("history catalogue through authenticated HTTP bridge", () => {
  it("paginates only live actually offered references, not all accessible assets", async () => {
    const first = await call("list", { limit: 1 }); expect(first.status).toBe(200);
    const a = await first.json(); expect(a.total).toBe(2); expect(a.next_offset).toBe(1);
    expect(a.items[0].asset_id).toBe("A"); expect(a.items[0].card).toContain("/asset-bridge/read");
    const second = await (await call("list", { offset: 1, limit: 1 })).json();
    expect(second.items[0].asset_id).toBe("B"); expect(second.next_offset).toBeNull();
    expect(JSON.stringify(a)).not.toContain("private"); expect(JSON.stringify(a)).not.toContain("body A");
  });
  it("searches names and checks current permission/version before revealing cards", async () => {
    const result = await (await call("list", { query: "Redis B" })).json(); expect(result.items).toHaveLength(1);
    mocks.list.mockResolvedValue([assets[0], assets[2]]);
    expect((await (await call("list", {})).json()).items.map((a: any) => a.asset_id)).toEqual(["A"]);
    mocks.list.mockResolvedValue([{ ...assets[0], quality_publication: { ...assets[0].quality_publication, revision_id: "r2" } }]);
    expect((await (await call("list", {})).json()).items).toEqual([]);
  });
  it("refreshes an exact historical reference evicted from Core's hot manifest before reading", async () => {
    const response = await call("read", { asset_id: "A", revision_id: "r1" });
    expect(response.status).toBe(200);
    expect(mocks.quality.mock.calls.map(c => c[0])).toEqual(["disclosure-remember", "disclosure-read"]);
    expect(mocks.quality.mock.calls[0][1].references).toEqual([{ asset_id: "A", revision_id: "r1" }]);
  });
  it("explicit forget suppresses replay/list/read without deleting the asset or audit", async () => {
    const result = await call("forget", { asset_id: "A", revision_id: "r1" });
    expect(result.status).toBe(200); expect((await result.json()).asset_deleted).toBe(false);
    expect((await store.read(scope)).references[referenceKey("A", "r1")]).toBeDefined();
    expect((await (await call("list", {})).json()).items.map((a: any) => a.asset_id)).toEqual(["B"]);
    expect((await call("read", { asset_id: "A", revision_id: "r1" })).status).toBe(409);
  });
  it("rejects forged identity, arbitrary URL, excessive pagination and uninitialized sessions", async () => {
    for (const data of [{ team_id: "other" }, { url: "https://example.com" }, { limit: 1000 }, { offset: -1 }]) {
      expect((await call("list", data)).status).toBe(400);
    }
    const wrong = await app.request("/asset-bridge/list", { method: "POST", headers: { ...headers, "x-conversation-id": "other" }, body: "{}" });
    expect(wrong.status).toBe(401);
  });
  it("expired ledgers do not return cards", async () => {
    await store.transaction(scope, async state => { state.updated = Date.now() - 31 * 86400_000; });
    expect((await (await call("list", {})).json()).items).toEqual([]);
  });
});
