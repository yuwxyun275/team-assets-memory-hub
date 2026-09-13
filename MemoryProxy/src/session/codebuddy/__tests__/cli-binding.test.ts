import { describe, expect, it } from 'vitest';
import { cliBinding, cliBindingMatches } from '../cli-binding.js';
const config = { enabled: true, headerAutoSelect: { enabled: true, teamHeader: 'x-team-id', agentHeader: 'x-agent-id', taskHeader: 'x-task-id' } } as any;
const headers = { 'x-team-assets-cli': '1', 'x-team-id': 'team', 'x-agent-id': 'agent', 'x-task-id': 'task', 'x-team-assets-workspace': encodeURIComponent('/tmp/项目') };
describe('explicit CodeBuddy CLI bindings', () => {
  it('preserves desktop behavior and requires complete CLI identity', () => {
    expect(cliBinding({}, config)).toBeUndefined();
    expect(() => cliBinding({ ...headers, 'x-task-id': '' }, config)).toThrow();
    expect(() => cliBinding(headers, { ...config, enabled: false })).toThrow();
    expect(() => cliBinding({ ...headers, 'x-team-assets-workspace': 'relative' }, config)).toThrow();
  });
  it('rejects a recovered binding to a different task or team', () => {
    const binding = cliBinding(headers, config);
    expect(binding?.workspace).toBe('/tmp/项目');
    expect(cliBindingMatches(binding, { team_id: 'team', agent_id: 'agent', task_id: 'task' } as any)).toBe(true);
    expect(cliBindingMatches(binding, { team_id: 'team', agent_id: 'agent', task_id: 'other' } as any)).toBe(false);
    expect(cliBindingMatches(binding, null)).toBe(false);
  });
});
