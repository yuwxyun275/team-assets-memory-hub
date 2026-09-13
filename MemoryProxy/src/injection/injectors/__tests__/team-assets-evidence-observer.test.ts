import { describe, expect, it } from "vitest";
import type { ContextMessage } from "../../types.js";
import {
  extractTeamAssetObservations,
  stableEvidenceTrace,
  stableTurnEvidenceTrace,
} from "../team-assets-evidence-observer.js";

describe("team assets evidence observer", () => {
  it("does not treat a test-file read or a comment mentioning tests as execution", () => {
    const calls = [
      { name: "Read", arguments: { file_path: "test_inventory.py" } },
      { name: "Bash", arguments: { command: 'python3 -c "# boundary probes (not covered by tests)\nprint(1)"' } },
      { name: "Bash", arguments: { command: "cd /repo && python3 -m pytest -v test_inventory.py" } },
    ];
    const result = extractTeamAssetObservations([{ role: "assistant", blocks: calls.map((call, i) => ({
      type: "tool_use", content: JSON.stringify(call), metadata: { tool_id: `call-${i}` },
    })) }]);
    expect(result.tool_calls.map(c => c.kind)).toEqual(["read", "other", "test"]);
  });
  it("requires structured declarations and extracts matching edit/test evidence", () => {
    const messages: ContextMessage[] = [
      {
        role: "assistant",
        blocks: [
          {
            type: "text",
            content: [
              '<team_asset_use>{"asset_id":"asset-wiki","decision":"按租户读取已发布配置","target":"feature_flags/service.py:FeatureFlagService.get_flag"}</team_asset_use>',
              '<acceptance_evidence>{"criterion_id":"criterion-1","mode":"automated","test_ids":["test_tenant_fallback"],"targets":["feature_flags/service.py"],"note":"故障回退测试通过"}</acceptance_evidence>',
              '<acceptance_plan>{"criteria":[{"text":"故障时保持租户隔离","category":"security","rationale":"Wiki 约束","source_asset_ids":["asset-wiki"],"target_paths":["feature_flags/service.py"],"candidate_test_ids":["test_tenant_fallback"]}]}</acceptance_plan>',
            ].join("\n"),
          },
          {
            type: "tool_use",
            content: JSON.stringify({
              name: "apply_patch",
              arguments: JSON.stringify({ path: "feature_flags/service.py", patch: "safe change" }),
            }),
            metadata: { tool_id: "call-edit" },
          },
          {
            type: "tool_use",
            content: JSON.stringify({
              name: "shell",
              arguments: JSON.stringify({ command: "python -m pytest -q tests hidden_tests" }),
            }),
            metadata: { tool_id: "call-test" },
          },
        ],
      },
      {
        role: "tool",
        blocks: [
          {
            type: "tool_result",
            content: "9 passed in 0.12s",
            metadata: { tool_use_id: "call-test" },
          },
        ],
      },
    ];

    const result = extractTeamAssetObservations(messages);
    expect(result.declarations).toEqual([
      {
        asset_id: "asset-wiki",
        decision: "按租户读取已发布配置",
        target: "feature_flags/service.py:FeatureFlagService.get_flag",
      },
    ]);
    expect(result.acceptance_declarations).toEqual([
      {
        criterion_id: "criterion-1",
        mode: "automated",
        test_ids: ["test_tenant_fallback"],
        targets: ["feature_flags/service.py"],
        note: "故障回退测试通过",
      },
    ]);
    expect(result.codebuddy_acceptance_plan?.criteria[0]).toEqual({
      text: "故障时保持租户隔离",
      category: "security",
      rationale: "Wiki 约束",
      source_asset_ids: ["asset-wiki"],
      target_paths: ["feature_flags/service.py"],
      candidate_test_ids: ["test_tenant_fallback"],
    });
    expect(result.tool_calls.map((item) => item.kind)).toEqual(["edit", "test"]);
    expect(result.tool_calls[0].arguments).not.toContain("safe change");
    expect(result.tool_calls[0].change_hash).toMatch(/^sha256:/);
    expect(result.tool_calls[0].changed_paths).toEqual(["feature_flags/service.py"]);
    expect(result.tool_results[0].success).toBe(true);
  });

  it("redacts business keys and keeps a stable non-secret trace", () => {
    const result = extractTeamAssetObservations([
      {
        role: "assistant",
        blocks: [{
          type: "tool_use",
          content: JSON.stringify({
            name: "shell",
            arguments: JSON.stringify({ command: "curl -H 'Authorization: Bearer sk-mem-secretvalue' /health" }),
          }),
          metadata: { tool_id: "call-secret" },
        }],
      },
    ]);
    expect(result.tool_calls[0].command).not.toContain("sk-mem-secretvalue");
    expect(stableEvidenceTrace("session-a", "task-a")).toBe(stableEvidenceTrace("session-a", "task-a"));
    expect(stableEvidenceTrace("session-a", "task-a")).not.toContain("session-a");
    expect(stableTurnEvidenceTrace("session-a", 5)).toBe(stableTurnEvidenceTrace("session-a", 5));
    expect(stableTurnEvidenceTrace("session-a", 5)).not.toBe(stableTurnEvidenceTrace("session-a", 6));
  });

  it("ignores malformed acceptance evidence instead of trusting prose", () => {
    const result = extractTeamAssetObservations([
      {
        role: "assistant",
        blocks: [{
          type: "text",
          content: [
            "所有验收标准均已完成。",
            '<acceptance_evidence>{"criterion_id":"wrong","test_ids":["test_x"]}</acceptance_evidence>',
          ].join("\n"),
        }],
      },
    ]);
    expect(result.acceptance_declarations).toEqual([]);
  });

  it("recognizes CodeBuddy camelCase and URI edit targets", () => {
    const result = extractTeamAssetObservations([
      {
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            content: JSON.stringify({
              name: "replace_in_file",
              arguments: JSON.stringify({
                filePath: "/workspace/feature_flags/service.py",
                content: "private source must not leave the proxy",
              }),
            }),
            metadata: { tool_id: "edit-camel-case" },
          },
          {
            type: "tool_use",
            content: JSON.stringify({
              name: "write_file",
              arguments: JSON.stringify({ uri: "file:///workspace/tests/test_service.py" }),
            }),
            metadata: { tool_id: "edit-uri" },
          },
        ],
      },
    ]);

    expect(result.tool_calls[0].target).toBe("/workspace/feature_flags/service.py");
    expect(result.tool_calls[0].changed_paths).toEqual(["/workspace/feature_flags/service.py"]);
    expect(result.tool_calls[0].arguments).not.toContain("private source");
    expect(result.tool_calls[1].target).toBe("file:///workspace/tests/test_service.py");
  });

  it("extracts explicit useful and irrelevant asset feedback", () => {
    const result = extractTeamAssetObservations([
      {
        role: "assistant",
        blocks: [{
          type: "text",
          content: [
            '<team_asset_feedback>{"asset_id":"asset-skill","signal":"ignored","reason":"本轮只做定位，暂未运行发布流程","target":"deploy"}</team_asset_feedback>',
            '<team_asset_feedback>{"asset_id":"asset-wiki","signal":"accepted","reason":"租户隔离约束直接决定了查询条件","target":"feature_flags/service.py"}</team_asset_feedback>',
          ].join("\n"),
        }],
      },
    ]);

    expect(result.feedback).toEqual([
      {
        asset_id: "asset-skill",
        signal: "ignored",
        reason: "本轮只做定位，暂未运行发布流程",
        target: "deploy",
      },
      {
        asset_id: "asset-wiki",
        signal: "accepted",
        reason: "租户隔离约束直接决定了查询条件",
        target: "feature_flags/service.py",
      },
    ]);
  });

  it("keeps the final pytest summary when CodeBuddy wraps a long tool result", () => {
    const result = extractTeamAssetObservations([
      {
        role: "tool",
        blocks: [{
          type: "tool_result",
          content: JSON.stringify({
            status: "success",
            success: true,
            result: {
              stdout: `${"test output\n".repeat(180)}8 passed in 0.08s`,
            },
          }),
          metadata: { tool_use_id: "call-long-test" },
        }],
      },
    ]);

    expect(result.tool_results[0].success).toBe(true);
    expect(result.tool_results[0].summary).toContain("8 passed in 0.08s");
    expect(result.tool_results[0].summary.length).toBeLessThanOrEqual(1200);
  });
});
