# 第七批：真实上下文验收规划与独立 CI 验证

## 1. 一句话说明

CodeBuddy 负责根据“当前任务、这一轮选中的团队资产、实际代码路径和仓库测试”提出该测什么；
独立 Runner 或企业 CI 负责真正执行测试并决定是否通过。两者不能互相代替。

```text
任务描述 + 本轮团队资产 + 代码/测试上下文
                    ↓
          CodeBuddy 候选验收计划
          （只建议，不能判通过）
                    ↓
       既有测试映射 / 新测试覆盖缺口
                    ↓
             CodeBuddy 修改代码
                    ↓
       独立本地 Runner / 企业 CI 执行
                    ↓
  工程结果 + 业务验收 + 资产效果分别回执
```

## 2. 为什么比“手工写验收标准”更适合企业

- 开工不要求开发者先手写完整测试清单；标题和描述仍是唯一必填项。
- 创建任务时的文字规则只提供即时预览；CodeBuddy 真正开始任务后，会用这一轮实际召回的
  Wiki、Chat Memory、Code Graph、Skill，以及已观察到的代码和测试重新生成建议。
- 建议会说明“为什么要测、来自哪项团队资产、可能对应哪个测试、哪里还缺测试”。
- 负责人确认前，建议状态始终是 `proposed`，不会被当成业务事实。
- CodeBuddy 的文字回答或本地自报不能让任务变绿；采用 `trusted_ci` 策略的新任务必须收到
  独立 Runner 或签名可信企业 CI 的真实结果。

## 3. 验收规划器

实现：`team_asset_bench/acceptance_planner.py`。

输入仅包含最小上下文：

- Task 标题、描述、类型、目标路径；
- 本轮已经通过 ACL、相关性和 Token 预算筛选的团队资产；
- Proxy 从真实工具轨迹中提取并脱敏的活动路径、测试 ID、测试路径和测试框架。

输出每条候选标准都包含：

- 标准正文与类别；
- 生成理由；
- 来源资产 ID 和名称；
- 影响代码路径；
- 候选测试 ID；
- 覆盖缺口和置信度。

默认使用可重复的上下文规则规划器，便于离线开发与测试。设置
`TEAM_ASSET_ACCEPTANCE_PLANNER_MODE=openai` 且显式开启
`TEAM_ASSET_ALLOW_ACCEPTANCE_MODEL=true` 后，可通过 OpenAI 兼容接口调用 CodeBuddy/其他模型。
模型模式还必须配置独立的 `TEAM_ASSET_ACCEPTANCE_OPENAI_BASE_URL/MODEL/API_KEY`；不能
指回正在等待规划结果的同一条 Proxy 路由，以免形成递归请求。未授权或配置不完整时绝不
把团队资产发送到外部端点，并自动回退为本地规划器。正常 CodeBuddy 会话也可在读完真实
代码与测试后输出结构化修订计划，由 Proxy 脱敏、校验资产/路径/测试引用后写回 Memory Hub。

## 4. 独立验证与“先失败后通过”

`LocalCiRunner` 只执行审核过的 argv 数组，不执行 shell 字符串。它支持两种证据：

1. 普通回归：修复后的仓库测试全部通过；
2. Bug 强证据：同一组测试在修复前工作区失败、在修复后工作区通过。

第二种会产生 `regression_proof`，只有出现相同检查的 `failed → passed` 且修复后全绿时，
`confirmed` 才为 `true`。这能回答“测试只是以前就会通过，还是本次修复真的改变了结果”。

示例：

```bash
PYTHONPATH=. python3 -m team_asset_bench.local_ci \
  --workspace /path/to/fixed-worktree \
  --before-workspace /path/to/broken-worktree \
  --discover \
  --trace-id '<当前 CodeBuddy 轮次 Trace>' \
  --changed-path feature_flags/service.py \
  --acceptance-criterion '缓存故障时安全回退且不产生未处理的 5xx' \
  --endpoint http://127.0.0.1:8765
```

没有真实公司的 CI 也能先用本地 Runner 验证完整边界；将来接入 GitHub Actions、GitLab CI
或 Jenkins 时，回执契约不变。远程回执还必须绑定 Commit SHA，并分别通过 GitHub HMAC、
GitLab Token 或 Jenkins HMAC 验证；JSON 中自行填写 `webhook_verified=true` 不会获得信任。

## 5. 用户可见结果

Memory Hub 任务详情的每轮时间线新增两块：

- “CodeBuddy 基于本轮真实上下文生成的验收建议”：展示来源资产、生成理由、候选测试和覆盖缺口；
- “独立验证”：展示 CI 检查，并在有强证据时显示“修复前失败 → 修复后通过”。

工程完成、业务验收和资产贡献继续分开：

- CI 通过只说明代码结果正确；
- 资产必须真实影响决策/修改并被相关测试验证，才能进入 `validated`；
- 只有可信反事实结果才能进一步进入 `contributed`。

## 6. 当前边界

- 本地已经完整实现与验证独立 Runner；真实企业 CI 因当前没有可用组织仓库与密钥，未做线上联调。
- 自动仓库测试发现当前以 Python/pytest 为主，但 CI 标准回执已支持多提供方。
- 模型规划接口已经实现，默认不调用外部模型，避免未经授权外发团队资产。
