import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMetadataStore } from "../../metadata/store/sqlite-adapter.js";
import { AssetDisclosure } from "../disclosure.js";
import { QualityLifecycle, type Publication } from "../lifecycle.js";
import { snapshot } from "./fixtures.js";

const stores: SqliteMetadataStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); vi.useRealTimers(); });
const scope = { agent_id: "agent", session_id: "session", task_id: "task" };
const ref = { asset_id: "asset-1", revision_id: "rev-1" };
function setup(file = ":memory:") {
  const store = new SqliteMetadataStore(file); store.init(); stores.push(store);
  const quality = new QualityLifecycle(store.qualityRecords, async () => ({ team_id: "team", version: 1 }));
  // A storage/authorization contract fixture, not a real quality judgment.
  let publication: Publication | null = { revision_id: "rev-1", snapshot: snapshot(), expected_version: 1,
    report: {} as any, approved_by: "reviewer", approved_at: Date.now() };
  const allowed = vi.fn(async () => publication);
  return { store, quality, allowed, disclosure: new AssetDisclosure(quality, allowed),
    setPublication: (p: Publication | null) => { publication = p; }, publication };
}
async function remembered(s: ReturnType<typeof setup>) {
  return s.disclosure.remember("team", "owner", { ...scope, references: [ref] });
}
const readInput = { ...scope, ...ref, request_id: "request" };

describe("persistent progressive disclosure", () => {
  it.each(["llm_wiki", "chat_memory", "code_graph", "skill"] as const)("reads the entire approved %s unit, without source evidence", async type => {
    const s = setup(); s.setPublication({ ...s.publication!, snapshot: snapshot(type) }); await remembered(s);
    const result = await s.disclosure.read("team", "owner", readInput);
    expect(result.body).toBe(snapshot(type).body); expect(result.complete).toBe(true);
    expect(result).not.toHaveProperty("sources"); expect(result).not.toHaveProperty("report");
    expect(await s.quality.records.list("exposure")).toHaveLength(0);
  });
  it("keeps pointers through restart and loss of all conversational text", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "disclosure-recovery-")), "metadata.db");
    const first = setup(file); await remembered(first); first.store.close();
    const second = setup(file);
    expect((await second.disclosure.list("team", "owner", scope)).references).toMatchObject([ref]);
    expect((await second.disclosure.read("team", "owner", readInput)).body).toBe(snapshot().body);
  });
  it("does not infer body exposure or usefulness from a card or read response", async () => {
    const s = setup(); await remembered(s);
    await s.disclosure.read("team", "owner", readInput);
    await s.disclosure.read("team", "owner", readInput);
    expect(await s.quality.records.list("disclosure-read")).toHaveLength(1);
    expect(await s.quality.records.list("exposure")).toHaveLength(0);
  });
  it("does not let a pointer cross team/user/agent/task/session boundaries", async () => {
    const s = setup(); await remembered(s);
    for (const [team, actor, input] of [
      ["other", "owner", readInput], ["team", "other", readInput],
      ["team", "owner", { ...readInput, agent_id: "other" }],
      ["team", "owner", { ...readInput, task_id: "other" }],
      ["team", "owner", { ...readInput, session_id: "other" }],
    ] as const) await expect(s.disclosure.read(team, actor, input)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("rechecks revocation and never swaps an old reference for latest", async () => {
    const s = setup(); await remembered(s); s.setPublication(null);
    await expect(s.disclosure.read("team", "owner", readInput)).rejects.toMatchObject({ code: "quality_gate_blocked" });
    s.setPublication({ ...s.publication!, revision_id: "rev-2", snapshot: { ...snapshot(), body: "new body" } });
    await expect(s.disclosure.read("team", "owner", readInput)).rejects.toMatchObject({ code: "quality_gate_blocked" });
    await s.disclosure.remember("team", "owner", { ...scope, references: [{ ...ref, revision_id: "rev-2" }] });
    expect((await s.disclosure.read("team", "owner", { ...readInput, revision_id: "rev-2" })).body).toBe("new body");
  });
  it("rejects over-budget full reads instead of silently returning half an asset", async () => {
    const s = setup(); await remembered(s);
    await expect(s.disclosure.read("team", "owner", { ...readInput, max_chars: 1 })).rejects.toMatchObject({ code: "quality_content_budget_exceeded" });
    expect(await s.quality.records.list("disclosure-read")).toHaveLength(0);
  });
  it("expires pointers and rejects caller-controlled source URLs or identity fields", async () => {
    const s = setup(); await remembered(s);
    await expect(s.disclosure.read("team", "owner", { ...readInput, url: "http://external" })).rejects.toBeDefined();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31 * 86400_000);
    expect((await s.disclosure.list("team", "owner", scope)).references).toHaveLength(0);
    await expect(s.disclosure.read("team", "owner", readInput)).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("merges concurrent writes without duplicating references", async () => {
    const s = setup();
    await Promise.all([remembered(s), remembered(s)]);
    expect((await s.disclosure.list("team", "owner", scope)).references).toHaveLength(1);
  });
});
