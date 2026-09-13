import type { SessionInfo } from "../types.js";

export interface RegistrationConfirmationResult {
  awaitingUserInstruction?: boolean;
  bypassed?: boolean;
  resetFlow?: boolean;
  teamName?: string;
  sessionInfo?: Partial<SessionInfo> | null;
  agentDetail?: { name?: string } | null;
  taskDetail?: { name?: string } | null;
}

/**
 * 只有 CodeBuddy 的交互式首次绑定需要停靠一轮。
 * 请求头预选、reset、bypass 以及其它客户端保持原有行为。
 */
export function shouldPauseAfterInteractiveRegistration(
  agentSource: string,
  result: RegistrationConfirmationResult,
): boolean {
  return agentSource === "codebuddy"
    && result.awaitingUserInstruction === true
    && result.bypassed !== true
    && result.resetFlow !== true;
}

export function buildRegistrationConfirmationText(
  result: RegistrationConfirmationResult,
): string {
  const teamId = String(result.sessionInfo?.team_id ?? "");
  const agentId = String(result.sessionInfo?.agent_id ?? "");
  const taskId = String(result.sessionInfo?.task_id ?? "");
  const team = result.teamName || teamId || "未知团队";
  const agent = result.agentDetail?.name || agentId || "未知 Agent";
  const task = result.taskDetail?.name || taskId || "未关联任务";

  return [
    "✅ 团队资产关联完成",
    "",
    `- **Team**: ${team}`,
    `- **Agent**: ${agent}`,
    `- **Task**: ${task}`,
    "",
    "本轮只完成了身份与任务绑定，尚未执行任务，也没有修改代码或运行测试。",
    "请在下一条消息中明确告诉我：分析问题、制定方案，或开始执行。",
  ].join("\n");
}
