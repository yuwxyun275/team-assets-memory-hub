# TeamAssetBench：Python 精品项目

这是题目四的可运行纵向闭环，不是另一套只统计“召回多少条”的 RAG 演示。

它验证：

```text
原始 Session / Wiki / 代码图 / Skill
→ 来源校验与 candidate 资产
→ 权限、版本、可信度和 Token 预算筛选
→ 最小上下文注入
→ 资产影响具体决策、代码或测试
→ pytest 独立验证
→ 单资产消融证明贡献
→ JSON / HTML 资产使用回执
```

## 精品任务

目标代码是一个零外部依赖的 Python 多租户 Feature Flag Service。任务只告诉 Agent：缓存异常造成间歇性超时和 5xx；不会泄露以下项目专属答案：

- 只允许回退同租户 `published` 配置；
- draft 和跨租户数据必须阻断；
- Redis 请求路径禁止重试风暴；
- 故障与恢复必须在同一回归流程验证。

这些信息分别由架构/产品、资深后端、Code Graph、QA/SRE 资产贡献，新成员 Agent 执行任务。

## 一键运行

从本目录执行：

```bash
PYTHONPATH=. python3 -m team_asset_bench ingest
PYTHONPATH=. python3 -m team_asset_bench select --strategy minimal
PYTHONPATH=. python3 -m team_asset_bench evaluate
python3 -m pytest -q
```

## 多仓库正式评测

`benchmark-suite.json` 声明正式评测目标、代码仓库、工程场景和任务包。先检查当前覆盖情况：

```bash
PYTHONPATH=. python3 -m team_asset_bench suite-status
```

每个任务包必须包含 `task.json` 和独立的 `hidden_tests/`。代码仓库基础状态由清单中的
`fixture` 指定。运行器会为每次实验复制独立工作区，按无资产、全量资产、最小资产和
四类来源单独移除组成七组实验，并记录模型 Token、端到端时间、工具调用、修改尝试和
隐藏测试结果。

真实模型运行默认关闭。完成数据授权并配置 OpenAI 兼容端点后执行：

```bash
export TEAM_ASSET_ALLOW_EXTERNAL_MODEL=true
export TEAM_ASSET_OPENAI_BASE_URL='<OpenAI 兼容端点>'
export TEAM_ASSET_OPENAI_MODEL='<固定模型版本>'
export TEAM_ASSET_OPENAI_API_KEY='<本地密钥>'
export TEAM_ASSET_OPENAI_TEMPERATURE=0
export TEAM_ASSET_OPENAI_SEED=20260904
export TEAM_ASSET_EVAL_REPETITIONS=3
export TEAM_ASSET_EVAL_CONCURRENCY=4
PYTHONPATH=. python3 -m team_asset_bench evaluate-suite-live
```

每次有效运行都会写入独立检查点。相同数据、资产和模型配置再次执行时会自动跳过已有
成功运行。代码、隐藏测试、资产或模型配置变化后，实验指纹会变化，旧检查点不会混入
新结果。可以用 `--max-runs` 限制本次新增运行数量，也可以用 `--task-id` 先完成小规模
Pilot。

正式产物位于 `results/suite_live/`：

- `evaluation-summary.json` 保存全部原始运行记录、分组聚合、P95 和配对 Bootstrap 置信区间
- `FORMAL_SUITE_EVALUATION_REPORT_CN.md` 保存完整中文实验报告
- `RESUME_METRICS_CN.md` 保存由真实数字自动生成的简历表述
- `runs/<run-id>/` 保存单次运行记录和资产证据回执

只有实际覆盖达到 4 个代码仓库、6 类工程场景和 48 个任务，七组实验各重复 3 次，获得
1008 次有效运行，并且每次都有隐藏测试、Input Token 和时延记录时，报告才会将
`resume_ready` 标记为 `true`。否则简历文件只输出差距，不会用目标数字冒充实验结果。

产物位于 `results/`：

- `evaluation-summary.json`：七组对照与单资产消融；
- `FORMAL_EVALUATION_REPORT_CN.md`：正式中文评测报告；
- `evaluation-dashboard.html`：对照看板；
- `minimal_team_assets/asset-receipt.html`：最佳组资产使用回执；
- 每组 `pytest-output.txt` 和 JSON/HTML 回执。

## 本地编排 API

```bash
PYTHONPATH=. python3 -m team_asset_bench serve --host 127.0.0.1 --port 8765
curl -s http://127.0.0.1:8765/health
curl -s -X POST http://127.0.0.1:8765/v1/context/select \
  -H 'Content-Type: application/json' \
  --data '{"strategy":"minimal"}'
```

生产环境应设置 `TEAM_ASSET_SERVER_TOKEN`，并由 MemoryProxy 使用内部地址访问。服务默认只绑定 `127.0.0.1`，不会读取或记录业务 `sk-mem-…` Key。

## Memory Hub + CodeBuddy 完整体验

### 已落地的可见实验

本机 Memory Hub 已创建并验证以下真实对象：

- Team：`new_asset_test_01`；
- Task：`Feature Flag 团队资产全链路实验`；
- 四类资产：Wiki、Chat Memory、Code Graph、Skill；
- 执行角色：架构/产品、资深后端、QA/SRE、新成员后端；
- 使用回执：在任务看板打开上述 Task，可直接查看
  `recalled → selected → injected → used → validated → contributed`
  六阶段、逐资产决策/代码/测试映射和反事实对照。

当前本地 `mentor-demo` 账号已加入该实验 Team，便于直接从 Team 切换器进入验收。
业务 Key 仍只保存在被 Git 忽略且权限为 600 的 `runtime/` 文件中。

在三容器已经启动的前提下，从本目录执行：

```bash
# 1. 幂等创建精品团队、四个角色 Agent 与任务；密钥只写入 runtime/（权限 600）
PYTHONPATH=. python3 -m team_asset_bench.register_hub

# 2. 启动编排器；它会自动加载 runtime/hub-binding.json
PYTHONPATH=. python3 -m team_asset_bench serve --host 127.0.0.1 --port 8765

# 3. 在仓库根目录构建并开启完整 Proxy 链路
docker build -t tdai-local/memory-proxy:2.0.1-team-assets MemoryProxy
cd ../../deploy/global-images
PROXY_IMAGE_OVERRIDE=tdai-local/memory-proxy:2.0.1-team-assets \
PROXY_FULL_STACK=1 PROXY_ENABLE_TEAM_ASSETS=1 ./start-proxy.sh
```

随后在 CodeBuddy 新建会话，选择“是，关联团队资产”→“Feature Flag 团队资产精品演示”→“新成员后端工程师”→“多租户 Feature Flag 缓存故障安全回退”。四类资产会经过 ACL、版本、可信度与预算筛选后进入上下文。

若要复现本次可见实验，请把 `register_hub` 的 Team/Task 参数设为
`new_asset_test_01` / `Feature Flag 团队资产全链路实验`，再运行
`team_asset_bench.sync_hub_assets` 导入四类资产。真实运行中，MemoryProxy 的证据
观察器会从 CodeBuddy 协议消息、结构化 `<team_asset_use>` 声明、编辑/测试工具调用
和工具结果中自动形成 `used` 与 `validated`。第二版不再允许演示脚本主动写入
`contributed`：服务器必须先取得真实工程验证证据，再匹配仓库/版本/任务类型一致的
可信反事实评测，最后自动派生 `contributed`。体验项目当前包含 9 项仓库测试，但它们
只是该仓库自己的测试集合，并不是系统要求所有团队手工填写的固定模板。Memory Hub
Task 抽屉直接渲染同一条 Trace，无需事后脚本伪造使用阶段。

不连接外部模型也能复现这条自动证据链。`register_hub` 会在 Git 忽略的
`runtime/` 中幂等生成两个互相独立、权限为 600 的服务 Token（不会打印值）。
分别启动本地模拟上游和编排器：

```bash
# 终端 A：只接收摘要审计，不保存请求正文
PYTHONPATH=. python3 -m team_asset_bench.mock_openai \
  --host 0.0.0.0 --port 8770 \
  --api-key-file runtime/mock-upstream.token

# 终端 B：Docker Proxy 通过 host.docker.internal 访问，非 loopback 必须带服务 Token
TEAM_ASSET_SERVER_TOKEN_FILE=runtime/orchestrator.token \
PYTHONPATH=. python3 -m team_asset_bench serve \
  --host 0.0.0.0 --port 8765 \
  --hub-env runtime/new_asset_test_01.env \
  --bindings-file runtime/new_asset_test_01-binding.json \
  --local-ci-auto \
  --local-ci-allowed-root /Users/xiaomo/CodeBuddy \
  --local-ci-discover
```

`--local-ci-allowed-root` 是明确的本地执行安全边界，请替换为当前机器上存放体验仓库的
父目录。它是有意必填的：开启自动独立验证时，服务不会执行该目录以外的任何仓库命令。
页面会每 5 秒刷新一次进行中的任务；CodeBuddy 修改代码后，独立 Runner 通过才会自动把
任务更新为“已完成”，后续“完成了吗”等纯询问轮次不会清空上一轮工程证据。

再从 `deploy/global-images` 临时把 Proxy 上游指向本地模拟服务：

```bash
PROXY_IMAGE_OVERRIDE=tdai-local/memory-proxy:2.0.1-second-batch \
PROXY_FULL_STACK=1 PROXY_ENABLE_TEAM_ASSETS=1 \
PROXY_UPSTREAM_URL_OVERRIDE=http://host.docker.internal:8770/v1 \
PROXY_UPSTREAM_API_KEY_FILE=../../evaluation/team_asset_bench/runtime/mock-upstream.token \
PROXY_UPSTREAM_MODEL_OVERRIDE=local-team-assets-smoke \
PROXY_CLIENT_MODEL_OVERRIDE=deepseek-v4-flash \
PROXY_TEAM_ASSET_SERVICE_TOKEN_FILE=../../evaluation/team_asset_bench/runtime/orchestrator.token \
./start-proxy.sh
```

然后回到 `evaluation/team_asset_bench` 运行：

```bash
PYTHONPATH=. python3 -m team_asset_bench.proxy_evidence_demo \
  --session-id codebuddy-team-assets-second-batch-v1
```

该命令使用真实 Proxy/Session/工具消息协议；本地模拟上游只用于验证证据采集，
不会把固定模型响应计入任务完成率。验收脚本会读取服务端回执，但不会调用人工
贡献接口；完成输出应为 9/9，六阶段均为 4。

验收结束后恢复原上游，并保持团队资产不外发：

```bash
cd ../../deploy/global-images
PROXY_FULL_STACK=1 PROXY_ENABLE_TEAM_ASSETS=0 ./start-proxy.sh
```

`PROXY_ENABLE_TEAM_ASSETS=1` 会把筛选后的团队上下文发送给所配置的模型上游，只能在该上游已获团队数据授权时开启。无人值守验收结束后，运行中的真实外部上游已安全恢复为 `PROXY_ENABLE_TEAM_ASSETS=0`；本地模拟上游的无外发验收证据保存在 `results/live-proxy-integration.json`。

如果编排器不可达，Proxy 会 fail-open，不阻断普通模型请求。`register_hub` 不输出完整 Key，也不会使用旧 `uky-…` Key。

## 模型兼容

`team_asset_bench.openai_provider` 支持任意 OpenAI Chat Completions 兼容端点：

```bash
export TEAM_ASSET_OPENAI_BASE_URL='http://127.0.0.1:8096/codebuddy/default'
export TEAM_ASSET_OPENAI_MODEL='<Proxy 中配置的客户端模型名>'
read -s TEAM_ASSET_OPENAI_API_KEY
export TEAM_ASSET_OPENAI_API_KEY
```

密钥只从环境变量读取，客户端错误不会打印请求头或完整密钥。本次自动报告明确标记为 `deterministic-reference-policy`，不会把离线参考策略冒充真实模型成绩。

正式真实模型反事实评测使用相同的七组实验、隐藏测试和工具 Agent，每组至少重复
两次（建议 3–5 次）：

```bash
export TEAM_ASSET_ALLOW_EXTERNAL_MODEL=true
export TEAM_ASSET_EVAL_REPETITIONS=3
PYTHONPATH=. python3 -m team_asset_bench evaluate-live
```

只有团队明确授权把合成资产发送给所配置的 OpenAI 兼容上游后，才可设置安全开关。
未执行时正式报告会显示“未授权，未运行”，不会静默用参考策略替代。

## 数据接入

离线参考基准保留预构造的资产清单，使用中文
`raw/source_manifest.json` 作为经过人工构造/整理的候选清单，并通过
`evidence_anchors` 验证每项资产确实可追溯到原始资料。这一边界会在正式报告中
明确，不会把预构造资产包装成自动学习结果。主办方数据可替换为：

- Session JSONL；
- Markdown/文本知识；
- Git 仓库生成的 Code Graph；
- `SKILL.md` 工作流；
- 可选 OpenAI 兼容抽取器。

所有正式资产统一保留 `asset_id`、团队、贡献者、来源、版本、权限、验证状态、风险和内容哈希。

当前运行时由 Core 根据任务回执排队提炼，移除了编排器中固定的缓存故障候选模板。新历史资料也可经 Core 学习入口自动抽取。候选默认 `candidate`，经过质量评估与指定版本审核后才可发布。Task 抽屉会链接到质量中心；旧的直接批准接口不再使用。

新增实现和本地零真实模型验证见 [资产学习与 CLI 文档](../../MemoryCore/docs/ASSET_LEARNING_CN.md)。本目录历史 results 和 submission_work 是当时的实验／交付快照，不代表新生成机制或新真实模型成绩。

完整架构、验收清单与结果解释见 [SYSTEM_DESIGN_AND_ACCEPTANCE_CN.md](./SYSTEM_DESIGN_AND_ACCEPTANCE_CN.md)。

## 第五批：Memory Hub 原生四类资产联合检索

V5 已移除 `team_asset_bench.asset_payload` 这一演示专用前置条件。普通 Memory Hub Wiki、
Skill、Code Graph、Chat Memory 只要通过当前 User + Agent 的 Core ACL 且状态为
`approved`，就能直接进入逐轮选择链路。

选择器先进行容器级 BM25、稀疏向量、原生向量/图结构信号与 RRF 融合，再结合证据可信度、
版本、新鲜度、历史反馈和 Token 成本输出最小资产集；实际正文仍由 Wiki 查询、Memory
Hybrid Search、Code Graph 工具和 Skill Loader 按需读取。上一轮脱敏后的活动文件和工具
错误会参与下一轮推荐，但旧轮工具轨迹不会被冒充为新轮采用证据。

详细设计和验收结果见
[FIFTH_BATCH_ACCEPTANCE_CN.md](./FIFTH_BATCH_ACCEPTANCE_CN.md)。

## 第三批：真实会话内动态推荐

最新实现不再只在 Session 初始化时推荐一次资产。MemoryProxy 会在 CodeBuddy 的每个
人类对话轮次调用 `/v2/turns/recommend`，用本轮问题、当前活动文件和错误摘要重新选择
最小上下文。上一轮没有观察到采用证据的推荐只形成中性的 `unobserved` 记录；被采用、
验证或证明贡献的资产形成分级正反馈；只有明确不适用、重复、过期或错误时才降权。

项目 CI 与推荐闭环已经解耦：CI 只证明具名测试和变更结果，不能单凭“测试通过”伪造
资产被采用。任务是否完成也不再要求所有推荐资产都被使用。因此真实场景允许“推荐
5 项、采用 3 项、任务完成”；另外 2 项默认保持中性，只有收到明确无用反馈才会降权。

详细设计、API 和本地 CI 复现方式见
[THIRD_BATCH_ACCEPTANCE_CN.md](./THIRD_BATCH_ACCEPTANCE_CN.md)。

## 第四批：自动验证发现与保守可信归因

V4 不再依赖为每个任务手写固定的“9 项测试”。系统会从目标仓库发现 pytest 测试、
pytest 配置和常见 CI 文件，生成安全的参数数组式验证清单；企业 CI 回执必须绑定 Commit
SHA，远程回执只有通过受信 Webhook 校验后才能作为强证据。

资产从 `used` 进入 `validated` 还必须满足更严格的因果约束：模型给出结构化采用声明，
真实 Diff 命中资产作用路径，且资产对应的具名测试通过。任务完成与资产有效是两个独立
结论，避免“CI 全绿”被误写成“所有召回资产都有贡献”。系统还会保护已完成的权威回执，
后续不完整重试只能作为历史尝试保存，不能覆盖 9/9 的成功证据。

详细设计、实际回归结果和仍需遵守的边界见
[FOURTH_BATCH_ACCEPTANCE_CN.md](./FOURTH_BATCH_ACCEPTANCE_CN.md)。新版简历表述见
[RESUME_UPDATE_RECOMMENDATION_CN.md](./RESUME_UPDATE_RECOMMENDATION_CN.md)。

## 第六批：可选验收标准与企业 CI 闭环

V6 将人工验收标准从“创建任务的必填门槛”改为可选的业务语义层。用户只填写标题和
任务描述也能创建任务；系统会生成可解释的候选验收标准，并明确标记为 `proposed`，
负责人确认前不会把模型/规则建议冒充为业务事实。

执行链路为：

```text
任务描述
→ 候选验收标准（可修改、确认或忽略）
→ 静态发现仓库测试与 CI 配置
→ 标准 ↔ 测试候选映射 / 覆盖缺口
→ CodeBuddy 修改代码，并为缺口补充仓库测试
→ 本地 Runner 或可信企业 CI 执行新旧测试
→ 工程结果与业务验收分别展示
```

## 第七批：真实上下文验收规划与独立 CI 验证

V7 把“任务创建时的文字规则”和“CodeBuddy 开工后的真实验收规划”分开：前者只做即时
预览；后者结合本轮筛选出的团队资产、活动代码路径和仓库测试，生成带来源、理由、候选
测试与覆盖缺口的验收建议。建议本身不能判定任务通过，新任务默认要求独立本地 Runner
或经过签名校验的企业 CI 回执。

本地 Runner 新增同一组检查的修复前/修复后对照；只有观察到 `failed → passed` 且修复后
全绿，才生成已确认的 Bug 回归证明。Memory Hub 会在逐轮时间线中同时展示验收建议、
来源团队资产、测试映射和独立验证结果。

详细设计与使用方式见
[SEVENTH_BATCH_CONTEXTUAL_ACCEPTANCE_CI_CN.md](./SEVENTH_BATCH_CONTEXTUAL_ACCEPTANCE_CI_CN.md)。

“工程检查通过”只由真实代码变更和受信测试结果决定；“业务验收完成”只在负责人确认
过标准且对应证据全部通过时成立。CI 全绿不会自动等于产品验收，也不会自动证明每项
推荐资产有贡献。新增测试作为普通仓库代码提交，随后由团队原有流水线和回归测试一起
执行，不要求资产系统替换企业 CI。

Memory Hub 任务详情会展示候选/已确认标准、仓库测试映射、覆盖缺口、工程状态和业务
验收状态。详细契约、状态机、复现命令和边界见
[SIXTH_BATCH_ACCEPTANCE_CN.md](./SIXTH_BATCH_ACCEPTANCE_CN.md)。
