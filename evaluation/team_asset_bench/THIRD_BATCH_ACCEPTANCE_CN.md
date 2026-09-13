# 第三批：会话内动态推荐、反馈学习与 CI 解耦

## 为什么需要第三批

前两批把一次任务的团队资产证据链跑通，并用任务看板验收契约判断完成。但真实企业不会要求开发者为每次对话手工设计一套隐藏测试，也不会只在会话初始化时推荐一次资产。

第三批把系统改成两个互相协作、但职责不同的闭环：

1. **推荐闭环**：每轮问题都重新判断需要什么团队资产；有证据证明有用的资产增强相似场景权重，明确不适用、重复、过期或错误的资产降权；仅仅“没有采用”保持中性，避免误伤。
2. **结果闭环**：项目已有测试、独立隐藏测试或企业 CI 负责证明代码结果；CI 结果不会反过来伪造“某项资产被使用”。

## 用户实际体验

```text
第 1 轮：理解模块职责
  → 推荐 Wiki + Code Graph
  → Skill 未产生采用证据，下一轮只记为中性的 unobserved

第 2 轮：定位 Redis 故障
  → 结合本轮问题重新推荐历史故障经验 + Code Graph
  → CodeBuddy 的结构化声明和工具调用证明两项资产影响了修改

第 3 轮：执行验证
  → 推荐 Skill
  → 本地 CI / 企业 CI 回传具名测试结果
  → 只有被实际采用且对应测试通过的资产进入 validated

后续相似任务
  → 综合相关性、权限、版本、新鲜度、Token 成本和历史反馈重新排序
```

任务看板不再只是显示最终的六个数字，而是显示逐轮时间线：本轮问题、推荐资产、采用/忽略/纠正反馈，以及独立 CI 检查。

## 已实现能力

### 1. 每轮动态检索

- MemoryProxy 按真实人类轮次生成稳定 Trace。
- 每轮向 `POST /v2/turns/recommend` 发送当前问题、活动文件、错误摘要和会话上下文。
- Task 关联变为可选；关联 Task 时可在任务看板聚合展示，不关联时仍可通过 Session 回执审计。
- 同一轮重试使用同一 Trace，不同轮必然是不同 Trace。

### 2. 正负反馈学习

- `used / validated / contributed` 由证据链自动生成正反馈。
- 上一轮已注入但没有影响任何操作的资产，在进入下一轮时记为中性的 `unobserved`，不因为“未观察到”就武断降权。
- CodeBuddy 可以输出结构化 `team_asset_feedback`，明确标注 `useful / not_applicable / duplicate / stale / incorrect`；旧的 `accepted / corrected` 仍作为兼容别名。
- `stale / incorrect` 必须给出可核验原因；只有明确反馈才进入负向学习。
- 排序器只在同仓库、版本、任务类型和模块等相似上下文内使用反馈，并采用时间衰减与贝叶斯收缩，避免少量偶然反馈把分数拉满。

### 3. CI 独立验证适配器

- 支持 `local-ci / github-actions / gitlab-ci / jenkins / trusted-replay` 标准化回执。
- 本地 CI 只执行经过审核的 `argv` 数组，不执行 shell 字符串；限制工作目录和超时。
- 保存检查名称、具名测试、通过状态、耗时、变更路径和 SHA-256 证据摘要。
- 只有已被采用的资产才能因相关测试通过进入 `validated`；无关推荐不会“搭便车”。

### 4. 完成判定与资产采用解耦

- 功能是否完成，只由任务结果条件决定：必要测试、代码变更和验收标准。
- 某项资产是否有效，由它是否影响操作以及相关结果是否通过独立验证决定。
- 因此“推荐了 5 项、只采用 3 项”可以同时得到：任务完成、3 项资产有效、2 项资产降权。这比强迫所有推荐资产都被使用更符合真实开发。

## 本地 CI 复现

体验工程中需要同时存在 `tests/` 与 `hidden_tests/`，然后执行：

```bash
PYTHONPATH=. python3 -m team_asset_bench.local_ci \
  --workspace /Users/xiaomo/CodeBuddy/team_asset_experience_01 \
  --manifest task_bundles/cache_outage_001/local-ci.json \
  --trace-id '<从本轮回执取得>' \
  --changed-path feature_flags/service.py \
  --endpoint http://127.0.0.1:8765
```

服务 Token 使用 `--service-token-file runtime/orchestrator.token` 从权限为 600 的本地文件读取；命令和回执都不打印业务 Key。

## API 摘要

- `POST /v2/turns/recommend`：每轮推荐最小资产上下文。
- `POST /v2/turns/feedback`：提交采用、忽略或纠正反馈。
- `POST /v2/ci/runs`：提交独立 CI 结果。
- `GET /v2/turns?session_id=...`：查询逐轮运行记录。
- `GET /v2/sessions/receipt?session_id=...`：查询整段会话聚合回执。

## 验收结论

第三批解决的是 Mentor 指出的真实落地问题：CI 不负责决定推荐什么资产，推荐器也不负责宣称功能已经正确。前者证明结果，后者从多轮交互和结果反馈中学习“什么资产在什么场景真正有帮助”。
