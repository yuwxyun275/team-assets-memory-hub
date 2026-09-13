# 第六批验收：可选验收标准与企业 CI 闭环

## 1. 解决的问题

旧流程把“人工填写验收标准”当作任务开工的前置条件，容易把 Memory Hub 变成另一套
企业流水线。新版把三种含义分开：

| 层次 | 回答的问题 | 权威证据 |
|---|---|---|
| 候选标准 | 这个需求可能还应该验证什么？ | 任务描述分析，仅作建议 |
| 工程验证 | 代码和自动化测试是否通过？ | 本地 Runner 或受信 CI 的真实结果 |
| 业务验收 | 产品目标是否被负责人认可并满足？ | 已确认标准及其测试/人工证据 |

因此，开发者不填写验收标准也可以创建任务和使用 CodeBuddy；已有企业 CI 继续负责执行
仓库测试，Memory Hub 只消费可校验的结果并展示证据链。

## 2. 用户流程

1. 在任务看板填写标题和描述。验收标准为空也允许创建。
2. 页面依据任务文字生成最多 5 条中文候选标准，状态为 `proposed`。
3. 负责人可以采用、修改或忽略候选；采用后状态为 `confirmed`。
4. 系统静态发现 pytest 测试、pytest 配置及 GitHub Actions、GitLab CI、Jenkins 配置。
5. 每条标准与仓库测试形成候选映射；没有匹配测试的标准显示为“覆盖缺口”。
6. CodeBuddy 修改业务代码；必要时把新测试写入仓库，而不是临时写入资产系统。
7. 本地 Runner 或企业 CI 执行新旧测试并返回 Commit/测试结果证据。
8. 任务详情分别显示“工程检查”和“业务验收”，同时继续展示资产六阶段证据链。

## 3. 数据契约

Task 的 `metadata_json.team_asset_acceptance` 使用 V2：

```json
{
  "version": "2",
  "criteria": [],
  "suggested_criteria": ["受影响模块的现有自动化测试与回归检查保持通过"],
  "criteria_status": "proposed",
  "required_tests": [],
  "require_code_change": null,
  "target_paths": [],
  "source": "system_generated_candidate",
  "generated_by": "deterministic-task-analyzer/v1"
}
```

`criteria_status` 语义：

- `not_requested`：尚未生成或填写；
- `proposed`：系统候选，不能代表业务验收；
- `confirmed`：负责人确认，进入业务验收判定；
- `not_required`：负责人明确声明该任务无需业务验收。

旧任务只有 `criteria` 时会向后兼容为 `confirmed`，不会破坏现有 Task。

## 4. 完成状态

系统不再用一个模糊的“完成”覆盖所有语义：

- `engineering_complete`：必需测试全部通过、没有已观察到的测试失败、编码任务存在真实
  自动化测试证据，并且需要修改代码时观察到了目标修改；
- `business_acceptance_complete`：标准已由负责人确认且全部通过，或负责人明确标记
  `not_required`；
- `completion_state=engineering_completed_business_pending`：工程已经通过，但业务仍待确认；
- `completion_state=completed`：工程与业务均完成。

兼容字段 `task_completed` 保留为工程完成状态，供现有 Task/CI 集成使用；界面会明确写成
“工程检查通过”，不把它展示成业务验收结论。

## 5. 可信边界

- 候选标准和静态测试映射都不能直接产生“通过”；
- 只有实际测试工具结果或经过信任校验的 CI 回执可以验证自动化标准；
- 远程 CI 回执仍须绑定 Commit SHA，并经过现有 Webhook/签名信任协议；
- 映射不到测试时保留缺口，不猜测“已经覆盖”；
- CI 证明代码结果，资产证据链另行证明某项资产是否影响决策、代码或验证；
- 推荐资产未被采用默认记为中性 `unobserved`，不会仅因任务完成就被奖励或惩罚。

## 6. 可重复验证

从本目录执行：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q

PYTHONPATH=. python3 -m team_asset_bench discover-verification \
  --workspace projects/feature_flag_service \
  --changed-path feature_flags/service.py \
  --acceptance-criterion '缓存不可用时服务安全回退且不产生 5xx' \
  --acceptance-criterion '所有管理员操作必须写入审计平台'
```

预期结果：第一条标准映射到仓库的缓存/回退测试，第二条在当前精品仓库显示
`coverage_gap`。映射只是测试计划，随后真实测试成功才会改变验收状态。

前端验证：

```bash
cd ../../../MemoryPanel/web
npm run build
```

## 7. 实现位置

- 候选标准生成：`MemoryPanel/web/src/lib/acceptance-suggestions.ts`、
  `team_asset_bench/completion.py`；
- Task V2 契约：`MemoryPanel/web/src/services/backendStore.ts`；
- 测试发现与覆盖映射：`team_asset_bench/verification_discovery.py`；
- 可信 CI 回执合并：`team_asset_bench/server.py`、`ci_adapter.py`、`runtime_store.py`；
- 双层完成判定：`team_asset_bench/completion.py`；
- 用户界面：`TaskCreateDialog.tsx`、`TaskDetail.tsx`。
