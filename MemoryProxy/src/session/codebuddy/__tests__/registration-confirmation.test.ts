import { describe, expect, it, vi } from "vitest";
import { completeRegistration } from "../init.js";
import {
  buildRegistrationConfirmationText,
  shouldPauseAfterInteractiveRegistration,
} from "../registration-confirmation.js";
import type { SessionInitState, TeamOption } from "../../types.js";

const teams: TeamOption[] = [{
  team_id: "team-demo",
  team_name: "研发一组",
  agents: [{ agent_id: "agent-backend", agent_name: "后端工程师" }],
  tasks: [{ task_id: "task-redis", task_name: "Redis 故障安全回退" }],
}];

const state: SessionInitState = {
  status: "pending_task_select",
  keyId: "conversation-1",
  startedAt: 1,
  attemptCount: 0,
  userId: "user-1",
  cachedTeams: teams,
  selectedTeamId: "team-demo",
  selectedAgentId: "agent-backend",
};

function metadataClient() {
  return {
    getAgent: vi.fn().mockResolvedValue({
      agent_id: "agent-backend",
      name: "后端工程师",
    }),
    getTask: vi.fn().mockResolvedValue({
      task_id: "task-redis",
      title: "Redis 故障安全回退",
    }),
    appendParticipationLog: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("CodeBuddy registration completion boundary", () => {
  it("pauses an interactive registration and persists the binding", async () => {
    const store = { set: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await completeRegistration(
      { agent_id: "agent-backend", task_id: "task-redis" },
      state,
      teams,
      "codebuddy:conversation-1",
      "conversation-1",
      "user-1",
      { enabled: true } as any,
      store,
      [{ role: "user", content: "你好" }],
      metadataClient(),
      "sk-mem-test",
      "default",
    );

    expect(result.awaitingUserInstruction).toBe(true);
    expect(result.teamName).toBe("研发一组");
    expect(shouldPauseAfterInteractiveRegistration("codebuddy", result)).toBe(true);
    expect(store.set).toHaveBeenCalledOnce();
  });

  it("does not pause header-preset registration, reset, bypass, or another client", async () => {
    const store = { set: vi.fn().mockResolvedValue(undefined) } as any;
    const preset = await completeRegistration(
      { agent_id: "agent-backend", task_id: "task-redis" },
      state,
      teams,
      "codebuddy:conversation-2",
      "conversation-2",
      "user-1",
      { enabled: true } as any,
      store,
      [{ role: "user", content: "开始执行" }],
      metadataClient(),
      "sk-mem-test",
      "default",
      { awaitUserInstruction: false },
    );

    expect(preset.awaitingUserInstruction).toBe(false);
    expect(shouldPauseAfterInteractiveRegistration("codebuddy", preset)).toBe(false);
    expect(shouldPauseAfterInteractiveRegistration("workbuddy", {
      awaitingUserInstruction: true,
    })).toBe(false);
    expect(shouldPauseAfterInteractiveRegistration("codebuddy", {
      awaitingUserInstruction: true,
      resetFlow: true,
    })).toBe(false);
    expect(shouldPauseAfterInteractiveRegistration("codebuddy", {
      awaitingUserInstruction: true,
      bypassed: true,
    })).toBe(false);
  });

  it("makes the local confirmation explicit about not executing the task", () => {
    const text = buildRegistrationConfirmationText({
      teamName: "研发一组",
      sessionInfo: { team_id: "team-demo", agent_id: "agent-backend", task_id: "task-redis" },
      agentDetail: { name: "后端工程师" },
      taskDetail: { name: "Redis 故障安全回退" },
    });

    expect(text).toContain("团队资产关联完成");
    expect(text).toContain("研发一组");
    expect(text).toContain("尚未执行任务");
    expect(text).toContain("没有修改代码或运行测试");
  });
});
