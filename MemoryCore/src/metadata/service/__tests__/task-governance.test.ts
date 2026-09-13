import { describe, expect, it, vi } from "vitest";
import type { V3AuthContext } from "../../router/auth.js";
import type { IMetadataStore } from "../../store/interface.js";
import type { TaskEntity, TeamMemberEntity } from "../../types.js";
import { MetadataError, MetadataService } from "../metadata-service.js";

const task = {
  task_id: "task-1",
  team_id: "team-1",
  creator_user_id: "user-creator",
  title: "task",
  source_type: "manual",
  agent_ids: [],
  user_ids: [],
  status: "pending",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as TaskEntity;

function context(userId: string): V3AuthContext {
  return {
    token: `key-${userId}`,
    userId,
    isAdmin: false,
    isSystemAdmin: false,
  };
}

function serviceFor(role: TeamMemberEntity["role"]) {
  const updateTask = vi.fn(async (_taskId: string, patch: Partial<TaskEntity>) => ({
    ...task,
    ...patch,
  }));
  const store = {
    getTaskById: vi.fn(async () => task),
    getTeamMember: vi.fn(async (_teamId: string, userId: string) => ({
      team_id: "team-1",
      user_id: userId,
      role,
      status: "active",
    } as TeamMemberEntity)),
    updateTask,
  } as unknown as IMetadataStore;
  return { service: new MetadataService(store), updateTask };
}

describe("task team governance", () => {
  it("allows an active team admin to write automation evidence to another creator's task", async () => {
    const { service, updateTask } = serviceFor("admin");
    const updated = await service.updateTaskForCaller(
      task.task_id,
      { metadata_json: '{"team_asset_receipt":{}}' },
      context("user-team-admin"),
    );

    expect(updated.metadata_json).toContain("team_asset_receipt");
    expect(updateTask).toHaveBeenCalledOnce();
  });

  it("still rejects an ordinary member who is not the task creator", async () => {
    const { service, updateTask } = serviceFor("member");

    await expect(service.updateTaskForCaller(
      task.task_id,
      { status: "completed" },
      context("user-other-member"),
    )).rejects.toMatchObject<Partial<MetadataError>>({ code: "permission_denied" });
    expect(updateTask).not.toHaveBeenCalled();
  });
});
