import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataService } from "../metadata-service.js";
import { SqliteMetadataStore } from "../../store/sqlite-adapter.js";
import type { V3AuthContext } from "../../router/auth.js";

const stores: SqliteMetadataStore[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); });
const caller: V3AuthContext = { userId: "user", token: "test", isAdmin: false, isSystemAdmin: false };
const scope = { team_id: "team", agent_id: "agent", task_id: "task", session_id: "session" };
function setup() {
  const db = new SqliteMetadataStore(":memory:"); db.init(); stores.push(db);
  const store = { qualityRecords: db.qualityRecords,
    getTeamMember: vi.fn(async () => ({ status: "active", role: "member" })),
    getAgentById: vi.fn(async () => ({ team_id: "team", agent_id: "agent", owner_user_id: "user", status: "active", visibility: "private" })),
    getTaskById: vi.fn(async () => ({ team_id: "team", task_id: "task" })),
    getAssetById: vi.fn(async () => ({ asset_id: "asset", team_id: "team", status: "approved", visibility: "team", version: 1 })),
  };
  const service = new MetadataService(store as any);
  const publication = { revision_id: "rev", snapshot: { asset_id: "asset", content_version: "v1", body: "reviewed body" } };
  vi.spyOn(service.quality!, "publication").mockImplementation(async team => team === "team" ? publication as any : null);
  const permission = vi.spyOn(service, "checkAssetPermission").mockResolvedValue({ allowed: true, reason: "test" });
  return { service, store, permission };
}
describe("asset disclosure caller authorization", () => {
  it("allows a team member to read an authorized reference without exposing review materials", async () => {
    const { service } = setup();
    await service.qualityForCaller("disclosure-remember", { ...scope, references: [{ asset_id: "asset", revision_id: "rev" }] }, caller);
    const result = await service.qualityForCaller("disclosure-read", { ...scope, asset_id: "asset", revision_id: "rev", request_id: "r" }, caller);
    expect(result).toMatchObject({ complete: true, body: "reviewed body", revision_id: "rev" });
    expect(result).not.toHaveProperty("sources");
  });
  it("checks current membership, current task and Agent boundaries before returning any reference", async () => {
    const { service, store } = setup();
    store.getTeamMember.mockResolvedValueOnce(null as any);
    await expect(service.qualityForCaller("disclosure-list", scope, caller)).rejects.toMatchObject({ code: "permission_denied" });
    store.getTaskById.mockResolvedValueOnce({ task_id: "task", team_id: "other" });
    await expect(service.qualityForCaller("disclosure-list", scope, caller)).rejects.toMatchObject({ code: "permission_denied" });
    store.getAgentById.mockResolvedValueOnce({ team_id: "team", agent_id: "agent", owner_user_id: "other", status: "active", visibility: "private" });
    await expect(service.qualityForCaller("disclosure-list", scope, caller)).rejects.toMatchObject({ code: "permission_denied" });
    store.getAgentById.mockResolvedValueOnce({ team_id: "team", agent_id: "agent", owner_user_id: "other", status: "active", visibility: "team" });
    await expect(service.qualityForCaller("disclosure-list", scope, caller)).resolves.toMatchObject({ references: [] });
  });
  it("rechecks use permission after the card was registered", async () => {
    const { service, permission } = setup();
    await service.qualityForCaller("disclosure-remember", { ...scope, references: [{ asset_id: "asset", revision_id: "rev" }] }, caller);
    permission.mockResolvedValue({ allowed: false, reason: "revoked" });
    await expect(service.qualityForCaller("disclosure-read", { ...scope, asset_id: "asset", revision_id: "rev", request_id: "r" }, caller)).rejects.toMatchObject({ code: "quality_gate_blocked" });
  });
  it("rejects identity fields that try to override the authenticated caller", async () => {
    const { service } = setup();
    await expect(service.qualityForCaller("disclosure-remember", { ...scope, user_id: "other", references: [] }, caller)).rejects.toBeDefined();
  });
});
