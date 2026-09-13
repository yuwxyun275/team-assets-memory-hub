import { describe, expect, it, vi } from "vitest";
import type { IMetadataStore } from "../../store/interface.js";
import type { AgentEntity, AssetEntity, TeamEntity } from "../../types.js";
import { MetadataService } from "../metadata-service.js";

const agent = {
  agent_id: "agent-1",
  team_id: "team-1",
  owner_user_id: "user-1",
  name: "Agent 1",
} as AgentEntity;

const legacySkill = {
  asset_id: "skill-1",
  team_id: "team-1",
  asset_type: "skill",
  name: "Skill 1",
  owner_user_id: "user-1",
  status: "active",
} as unknown as AssetEntity;

describe("runtime asset publication", () => {
  it("migrates legacy shared active skills to candidate, never bypassing content review", async () => {
    const updateAsset = vi.fn(async (_assetId: string, patch: Partial<AssetEntity>) => ({
      ...legacySkill,
      ...patch,
    }));
    const store = {
      getAgentById: vi.fn(async () => agent),
      getAssetById: vi.fn(async () => legacySkill),
      updateAsset,
      addAgentFixedAsset: vi.fn(async () => undefined),
    } as unknown as IMetadataStore;

    const result = await new MetadataService(store).ensureSkillAsset({
      skill_id: "skill-1",
      team_id: "team-1",
      agent_id: "agent-1",
      name: "Skill 1",
    });

    expect(result.status).toBe("candidate");
    expect(updateAsset).toHaveBeenCalledWith("skill-1", { status: "candidate" });
  });

  it("creates chat memory as an approved, injectable asset", async () => {
    const createAsset = vi.fn(async (input) => ({
      ...input,
      version: 1,
      usage_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      metadata_json: "{}",
    } as AssetEntity));
    const store = {
      getTeamById: vi.fn(async () => ({ team_id: "team-1" } as TeamEntity)),
      getAgentById: vi.fn(async () => agent),
      getAssetById: vi.fn(async () => null),
      createAsset,
      addAgentFixedAsset: vi.fn(async () => undefined),
    } as unknown as IMetadataStore;

    const result = await new MetadataService(store).ensureChatMemoryAsset({
      team_id: "team-1",
      agent_id: "agent-1",
    });

    expect(result.status).toBe("approved");
    expect(createAsset).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
  });
});
