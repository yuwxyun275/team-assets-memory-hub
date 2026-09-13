import { describe, expect, it, vi } from "vitest";
import type { TeamOption } from "../../types.js";
import { getLastUserMessageText } from "../cleaner.js";
import { handleSessionInit } from "../init.js";
import {
  extractAgentOnly,
  extractAssetConfirm,
  extractFromOptionText,
  extractTaskOnly,
  extractTeamFromOptionText,
} from "../extractor.js";

const team: TeamOption = {
  team_id: "team-vqlw09kx9d",
  team_name: "new_asset_test_01",
  agents: [
    { agent_id: "agt-experience01", agent_name: "新成员后端工程师" },
  ],
  tasks: [
    { task_id: "task-default", task_name: "本次不关联任务", isDefault: true },
    { task_id: "task-yg5ybisczm", task_name: "体验任务01：Redis故障安全回退 v1" },
  ],
};

function multiQuestionResult(
  questions: Array<Record<string, unknown>>,
  answers: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    status: "success",
    success: true,
    result: {
      type: "multi_question_result",
      questions,
      answers,
      message: "Questions displayed. Wait for user response before proceeding.",
    },
  });
}

describe("CodeBuddy session-init extractor", () => {
  it("uses the sole Agent when CodeBuddy only asks the Task question", () => {
    const xml = `
      <question_answer><questions>
        <question_item id="task"><answers>
          体验任务01：Redis故障安全回退 v1 (5ybisczm)
        </answers></question_item>
      </questions></question_answer>`;

    expect(extractFromOptionText(xml, [team], team.team_id)).toEqual({
      agent_id: "agt-experience01",
      task_id: "task-yg5ybisczm",
    });
  });

  it("never mistakes options in an unanswered JSON form for user selections", () => {
    const emptyTaskForm = multiQuestionResult([
      {
        id: "task",
        options: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"],
      },
    ]);
    const emptyTeamForm = multiQuestionResult([
      { id: "team", options: ["new_asset_test_01 (lw09kx9d)"] },
    ]);
    const emptyAgentForm = multiQuestionResult([
      { id: "agent", options: ["新成员后端工程师 (rience01)"] },
    ]);

    expect(extractTaskOnly(emptyTaskForm, [team], team.team_id)).toBeNull();
    expect(extractFromOptionText(emptyTaskForm, [team], team.team_id)).toBeNull();
    expect(extractTeamFromOptionText(emptyTeamForm, [team])).toBeNull();
    expect(extractAgentOnly(emptyAgentForm, [team], team.team_id)).toBeNull();
    expect(extractAssetConfirm(multiQuestionResult([
      { id: "asset_confirm", options: ["是，关联团队资产", "否，本次不关联"] },
    ]))).toBeNull();
  });

  it("parses explicit JSON answers instead of scanning the candidate list", () => {
    expect(extractTeamFromOptionText(multiQuestionResult(
      [{ id: "team", options: ["其他团队", "new_asset_test_01 (lw09kx9d)"] }],
      { team: "new_asset_test_01 (lw09kx9d)" },
    ), [team])).toBe(team.team_id);

    expect(extractFromOptionText(multiQuestionResult(
      [{ id: "task", options: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"] }],
      { task: "体验任务01：Redis故障安全回退 v1 (5ybisczm)" },
    ), [team], team.team_id)).toEqual({
      agent_id: "agt-experience01",
      task_id: "task-yg5ybisczm",
    });
  });

  it("accepts CodeBuddy 4.11 task answers returned as arrays or option letters", () => {
    const questions = [
      {
        id: "agent",
        options: ["架构师 (rchitect)", "新成员后端工程师 (rience01)"],
      },
      {
        id: "task",
        options: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"],
      },
    ];

    expect(extractFromOptionText(multiQuestionResult(
      questions,
      { agent: ["新成员后端工程师 (rience01)"], task: ["B"] },
    ), [team], team.team_id)).toEqual({
      agent_id: "agt-experience01",
      task_id: "task-yg5ybisczm",
    });
  });

  it("accepts answers keyed by the displayed question text", () => {
    const payload = multiQuestionResult(
      [
        { id: "agent", options: ["新成员后端工程师 (rience01)"] },
        { id: "task", options: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"] },
      ],
      {
        "请选择 Agent": "新成员后端工程师 (rience01)",
        "请选择关联任务": "体验任务01：Redis故障安全回退 v1 (5ybisczm)",
      },
    );

    expect(extractFromOptionText(payload, [team], team.team_id)).toEqual({
      agent_id: "agt-experience01",
      task_id: "task-yg5ybisczm",
    });
  });

  it("accepts an unambiguous questions[].answers selection but not a copied candidate list", () => {
    const selected = multiQuestionResult([
      {
        id: "task",
        options: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"],
        answers: ["体验任务01：Redis故障安全回退 v1 (5ybisczm)"],
      },
    ]);
    const candidatesOnly = multiQuestionResult([
      {
        id: "task",
        options: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"],
        answers: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"],
      },
    ]);

    expect(extractTaskOnly(selected, [team], team.team_id)).toBe("task-yg5ybisczm");
    expect(extractTaskOnly(candidatesOnly, [team], team.team_id)).toBeNull();
  });

  it("prefers a later XML user answer over the earlier form-display tool result", () => {
    const empty = multiQuestionResult([
      { id: "task", options: ["本次不关联任务", "体验任务01：Redis故障安全回退 v1 (5ybisczm)"] },
    ]);
    const answer = '<question_answer><question_item id="task"><answers>体验任务01：Redis故障安全回退 v1 (5ybisczm)</answers></question_item></question_answer>';

    expect(getLastUserMessageText([
      { role: "tool", tool_call_id: "call_session_init_1", content: empty },
      { role: "user", content: answer },
    ])).toBe(answer);
  });

  it("moves a selected Team with one Agent into the task-only state", async () => {
    let state: any = {
      status: "pending_team_select",
      keyId: "session-1",
      startedAt: Date.now(),
      attemptCount: 0,
      userId: "user-1",
      cachedTeams: [team],
    };
    const store = {
      get: () => state,
      set: async (_key: string, next: unknown) => { state = next; },
    } as any;
    const answer = '<question_answer><question_item id="team"><answers>new_asset_test_01 (lw09kx9d)</answers></question_item></question_answer>';

    const result = await handleSessionInit(
      "session-1",
      "user-1",
      [{ role: "user", content: answer }],
      { maxRetries: 3 } as any,
      store,
      { stream: false, questionsAsArray: false, modelId: "test", protocol: "openai" } as any,
    );

    expect(result.intercepted).toBe(true);
    expect(result.formData?.stage).toBe("task_select");
    expect(state.status).toBe("pending_task_select");
    expect(state.selectedTeamId).toBe(team.team_id);
    expect(state.selectedAgentId).toBe("agt-experience01");
  });

  it("asks for Agent and Task in two steps when a Team has multiple Agents", async () => {
    const multiAgentTeam: TeamOption = {
      ...team,
      agents: [
        { agent_id: "agt-architect", agent_name: "架构师" },
        { agent_id: "agt-experience01", agent_name: "新成员后端工程师" },
      ],
    };
    let state: any = {
      status: "pending_team_select",
      keyId: "session-split",
      startedAt: Date.now(),
      attemptCount: 0,
      userId: "user-1",
      cachedTeams: [multiAgentTeam],
    };
    const store = {
      get: () => state,
      set: async (_key: string, next: unknown) => { state = next; },
    } as any;
    const answer = '<question_answer><question_item id="team"><answers>new_asset_test_01 (lw09kx9d)</answers></question_item></question_answer>';

    const result = await handleSessionInit(
      "session-split",
      "user-1",
      [{ role: "user", content: answer }],
      { maxRetries: 3 } as any,
      store,
      { stream: false, questionsAsArray: false, modelId: "test", protocol: "openai" } as any,
    );

    expect(result.intercepted).toBe(true);
    expect(result.formData?.stage).toBe("agent_select");
    expect(state.status).toBe("pending_agent_select");
    expect(state.selectedTeamId).toBe(multiAgentTeam.team_id);
  });

  it("migrates an in-flight CodeBuddy combined form to Agent-first selection", async () => {
    const multiAgentTeam: TeamOption = {
      ...team,
      agents: [
        { agent_id: "agt-architect", agent_name: "架构师" },
        { agent_id: "agt-experience01", agent_name: "新成员后端工程师" },
      ],
    };
    let state: any = {
      status: "pending_agent_task",
      keyId: "session-legacy",
      startedAt: Date.now(),
      attemptCount: 1,
      userId: "user-1",
      cachedTeams: [multiAgentTeam],
      selectedTeamId: multiAgentTeam.team_id,
    };
    const store = {
      get: () => state,
      set: async (_key: string, next: unknown) => { state = next; },
    } as any;

    const result = await handleSessionInit(
      "session-legacy",
      "user-1",
      [{ role: "user", content: '<question_answer><question_item id="task"><answers>体验任务01：Redis故障安全回退 v1 (5ybisczm)</answers></question_item></question_answer>' }],
      { maxRetries: 3 } as any,
      store,
      { stream: false, questionsAsArray: false, modelId: "test", protocol: "openai" } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      "codebuddy",
    );

    expect(result.intercepted).toBe(true);
    expect(result.formData?.stage).toBe("agent_select");
    expect(state.status).toBe("pending_agent_select");
    expect(state.attemptCount).toBe(0);
  });

  it("loads Team Agents without filtering them by the current creator", async () => {
    let state: any;
    const store = {
      get: () => state,
      set: async (_key: string, next: unknown) => { state = next; },
    } as any;
    const metadataClient = {
      listTeams: vi.fn().mockResolvedValue([
        { team_id: team.team_id, name: team.team_name },
      ]),
      listAgents: vi.fn().mockResolvedValue([
        { agent_id: "agt-shared", name: "团队共享 Agent" },
      ]),
      listTasks: vi.fn().mockResolvedValue([
        { task_id: "task-shared", title: "团队共享任务" },
      ]),
    } as any;

    const result = await handleSessionInit(
      "session-team-shared",
      "user-member",
      [{ role: "user", content: "开始" }],
      { maxRetries: 3 } as any,
      store,
      { stream: false, questionsAsArray: true, modelId: "test", protocol: "openai" } as any,
      metadataClient,
    );

    expect(result.intercepted).toBe(true);
    expect(result.formData?.stage).toBe("asset_confirm");
    expect(metadataClient.listAgents).toHaveBeenCalledWith(team.team_id);
    expect(state.cachedTeams[0].agents[0].agent_id).toBe("agt-shared");
  });
});
