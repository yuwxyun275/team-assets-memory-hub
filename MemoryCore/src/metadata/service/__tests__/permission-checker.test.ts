import { describe, expect, it } from "vitest";
import type { AssetEntity, TeamMemberEntity } from "../../types.js";
import { checkPermission, roleDefaultCovers } from "../permission-checker.js";

const member = {
  team_id: "team-1",
  user_id: "user-member",
  role: "member",
  status: "active",
} as TeamMemberEntity;

const publishedTeamAsset = {
  asset_id: "asset-1",
  team_id: "team-1",
  owner_user_id: "user-owner",
  visibility: "team",
  status: "approved",
} as AssetEntity;

describe("team asset use permission", () => {
  it("lets an active member use a published team asset", () => {
    expect(roleDefaultCovers("member", "use")).toBe(true);
    expect(checkPermission({
      user: { user_id: "user-member" },
      asset: publishedTeamAsset,
      membership: member,
      action: "use",
      aclRecords: [],
      agentId: "agent-team",
    })).toEqual({ allowed: true, reason: "role_default:member" });
  });

  it("does not turn restricted assets into team-wide assets", () => {
    expect(checkPermission({
      user: { user_id: "user-member" },
      asset: { ...publishedTeamAsset, visibility: "restricted" },
      membership: member,
      action: "use",
      aclRecords: [],
      agentId: "agent-team",
    }).allowed).toBe(false);
  });
});
