import type { SessionInitConfig } from "../../types.js";

export function cliBinding(headers: Record<string, string>, config: SessionInitConfig) {
  if (headers['x-team-assets-cli'] !== '1') return undefined;
  if (!config.enabled || !config.headerAutoSelect?.enabled) throw new Error('cli_binding_disabled');
  const h = config.headerAutoSelect;
  const team = headers[h.teamHeader], agent = headers[h.agentHeader], task = headers[h.taskHeader];
  if (![team, agent, task].every(v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(v))) throw new Error('cli_binding_incomplete');
  let workspace: string;
  try { workspace = decodeURIComponent(headers['x-team-assets-workspace'] ?? ''); } catch { throw new Error('cli_workspace_invalid'); }
  if (!workspace.startsWith('/') || workspace.length > 1000 || /[\0\r\n]/.test(workspace)) throw new Error('cli_workspace_invalid');
  return { team, agent, task, workspace };
}
export function cliBindingMatches(binding: ReturnType<typeof cliBinding>, session: { team_id?: unknown; agent_id?: unknown; task_id?: unknown } | null | undefined) {
  return !binding || !!session && session.team_id === binding.team && session.agent_id === binding.agent && session.task_id === binding.task;
}
