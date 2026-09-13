# 竞赛任务一、六与工程收尾

这次实现补齐原始资料学习、任务结果提炼、候选审核入口、后台模型用量和 CodeBuddy CLI 适配。主办方资料尚不可得；真实模型实验按用户要求留到最后。合成样例、模拟审阅结论和本地协议测试不能当作真实模型准确率或竞赛收益。

## 两个入口，共用一条候选流程

历史入口：原始 JSONL Session、Markdown/产品文档、指定代码文件 → 输入校验 → 持久化学习队列 → 模型提炼 → 原文引用核验 → candidate 资产 → 原有质量队列 → 指定版本的负责人审核 → 原有检索和 asset-bridge。

任务入口：Core 保存带执行结果的任务回执 → 持久化触发记录 → 从当前任务回执、原资产快照、本人可用的后续事件组织材料 → 同一学习队列。任务完成、阶段结果和有效后续反馈均可触发；也可以在看板主动提交已有执行证据。没有足够的新经验时允许 `no_candidates`。

统一提炼管线支持项目经验、失败模式、原资产修订建议、Skill 候选和 Workflow 候选，也允许建议复用已有资产或不生成。修订／复用必须引用目标原文及额外依据，修订只创建独立候选，不改写原资产。Skill／Workflow 以标准 SKILL.md 审核快照保存，批准后通过现有检索与 asset-bridge 按需读取；不需要 Agent 调用原生创建工具，也不新建 Workflow 执行引擎。旧 Skill 归档与推荐效果分／适用性反馈继续运行。

来源保存 locator、revision、内容 SHA-256、合成标记、可见范围和引用字符位置。可引用测试结果，但候选验证状态始终为 `requires_review`，不把提交者提供的测试文本自动视为独立验收。任务材料会按预算截取，并记录 truncated；材料不足不能解释成没有失败。

项目、版本和合成标记纳入不可变审核快照；检索器按该快照校验仓库与版本，不通过修改外层元数据扩大适用范围。原始输入最多 24 份、单份 60000 字符、整批 140000 UTF-8 字节，为生成正文和审核快照保留预算；超限需要分批。

## 何时提炼与如何分流

任务完成、阶段测试结果或当前观察窗口内的后续纠错／复用评价触发异步检查。默认等待 15 秒汇集相邻事件，连续变化最多延后到该批首个信号后 120 秒，同一任务自动提炼至少间隔 60 秒。相同证据去重，过期的评价不会触发新判断。此处是检查机会，不保证产出新资产。

生成前以标题／描述的中英文词项重叠检索最多 2000 项元数据，按相关性取最多 8 份当前有权读取的已审核正文或学习候选，且总材料保持预算。模型对比覆盖关系：已有方法可用就建议复用，已有方法不完整就生成修订，只有知识结论就生成经验，存在有依据的新流程才生成 Skill／Workflow。这是有界文本检索，不是全库语义去重保证；准确性需要实验校准。

每个步骤与验证方法都引用候选证据数组，程序逐字检查原文并校验引用下标。流程还包含输入参数、前置条件、失败分支、停止条件、恢复说明和不适用范围。跨项目流程必须声明适配参数，不能引用不存在的参数。相同所有者、项目、版本和可见范围下的同一结构化流程复用候选 ID；新来源保存在关联记录，不反复创建／计入效果。

历史输入或当前证据不足时允许 no_candidates，理由在看板显示。复用建议单独保存在 learning-resolution，不产生 asset_used/validated/contributed 事件，也不自动增加效果分。新管线策略为 procedure-learning/v2；同一输入在同策略下幂等，新策略可以重新检查旧材料。

## 流程范围与实际验证

workflow_scope 保存建议层级（project、team、cross_project）、适用条件、材料来源项目／版本、证据索引与执行前检查要求。project 继续执行严格仓库／版本门禁；team/cross_project 可以在同一权限边界内被其他项目检索，但卡片和正文明确要求先核对当前项目约定、必需参数及环境，条件未知或不成立时停止并提出适配修订。跨项目不扩大团队 ACL 或 private 来源权限。

新流程一律为 unverified_workflow；模型不能提交已验证范围字段，审核通过也不会把它改成已经执行验证。来源任务结果只证明其记录的原任务范围；后续的具体采用和验证情况通过版本绑定的任务回执、使用观察与测试证据积累，不能解释成完整流程普遍有效。跨项目自由文本条件由执行 Agent 核对，当前并没有独立验证器可以自动证明任意环境满足所有条件。

后续有效的错误／不适用反馈重新触发提炼，并沿用原有质量复评、适用性调整和负责人暂停发布机制；模型不直接修改或下架权威内容。扩大适用范围需要新快照重新评估与审核。

## 使用

在看板资产质量中心上传原始资料，填写仓库、版本和范围。资料默认仅本人可见，明确选择“当前团队”后才按团队材料处理。提炼结果自动提交内容评估；任务卡片与学习列表可进入质量中心查看指定候选的来源和审核报告。日常生成和使用评价无需人工填写总结；共享发布仍需有权限的审核者决定。

命令行准备资料（纯本地，不调用模型）：

```bash
node scripts/team-assets.mjs prepare evaluation/learning-fixture/source-manifest.json /tmp/inventory-learning-input.json
```

源清单只声明项目范围与文件位置，不包含预先编写的资产答案。示例中的文档、Session 和代码明确标记 synthetic；配套 Python 测试可以真实执行，但该结果仍只验证这个合成小项目。

接入实际 Core 时设置 `TEAM_ASSET_CORE_URL`、`TEAM_ASSET_SERVICE_ID`、`TEAM_ASSET_TEAM_ID`、`TEAM_ASSET_USER_KEY`。密钥只从环境读取。

```bash
# 以下 submit/learn-task 会排队调用实际配置的模型；本轮验收不执行它们。
node scripts/team-assets.mjs submit evaluation/learning-fixture/source-manifest.json
node scripts/team-assets.mjs learn-task TASK_ID
node scripts/team-assets.mjs jobs
node scripts/team-assets.mjs job LEARNING_JOB_ID
node scripts/team-assets.mjs costs TASK_ID
```

API 均为经过原有用户鉴权的 `/v3/meta/asset/quality/` POST 路由：`learning-submit`、`learning-from-task`、`learning-list`、`learning-details`、`learning-candidate`、`costs`。客户端不得通过 history 接口伪造 task 模式；任务入口读取 Core 已保存的结果。Panel 使用原有 meta 代理。

## 权限与队列

质量详情、列表、使用回执、人工处理和审计遵循资产读取权限；管理员不能读取他人的 private 资产。restricted 资产的显式 ACL 会在拒绝前加载。审核通过不扩大资产可见范围。

生成前和落库前重新核对成员身份及引用资产的权限、正文和版本，包括用于比较的候选；任意输入来源受限时，候选仅本人可见。拥有引用材料的阅读权限不自动意味着可以把它发布给整个团队。候选共享应由来源所有者依照现有资产权限流程处理。处理中的来源版本变化或权限撤回会结束该学习任务，不能无限重试旧引用。历史学习记录保留原快照供审计；来源版本更新不抹去历史，来源权限撤回则阻止继续读取。

学习任务与材料同一条 CAS 记录持久化，最多三次尝试，每团队队列最多 50、每日最多 200；不会无限重试。模型结果先保存，再幂等创建候选与审核任务，进程重启后可以继续。任务写入与触发记录使用两个持久化写入，触发写失败会让调用方收到错误并重试，不宣称跨表原子事务或多实例高可用。

## 成本口径

质量审核、适用性审核、效果审核、历史抽取、任务提炼通过 SDK 记录实际用量。调用开始即保存标识，正常结束或失败再补结果；崩溃后未结束调用保留为用量未知。保存模型、任务／资产／队列关联和耗时，不保存模型正文或密钥。失败、缺失用量不能折算成零。

`costs` 返回后台明细与按用途汇总；可传带版本和币种的价格表估算费用。缺少价格或缓存计费字段时费用为 null。后台耗时不等于用户等待时间，后台明细也不冒充整体成本。

真实实验前，把主对话请求与响应按 request_id 关联，补齐 model、task_id，保留实际 usage。再导出 Core costs 明细合并：

```bash
node evaluation/asset_recommendation_bench/accounting.mjs main-calls.jsonl background-costs.json prices.json total-costs.json
```

价格表为数组，每项包含 `model`、`version`、`currency`、`input_per_million`、`output_per_million`，以及有缓存时相应的 `cache_read_per_million`／`cache_write_per_million`。资产建设成本单列一次；任务期成本按 task_id 汇总。不得把旧实验中未采集的后台用量补写成实测值。

## CodeBuddy CLI

`agents/codebuddy/cli.mjs` 使用命令行参数显式绑定团队、Agent、任务、会话和工作区，密钥通过子进程环境传递。Proxy 校验授权后的绑定与这些参数一致；不匹配、禁用绑定或初始化异常均返回错误。支持新会话和 `--resume`；更换任务应新建会话。

```bash
node agents/codebuddy/cli.mjs --proxy http://127.0.0.1:8096/codebuddy/default --model MODEL_NAME --team TEAM_ID --agent AGENT_ID --task TASK_ID --workspace /absolute/project/path --prompt "执行任务并保留测试证据"
```

需设置 `TEAM_ASSET_USER_KEY`；Proxy 需启用 sessionInit、headerAutoSelect 和团队资产注入。当前本机验证版本为 CodeBuddy CLI 2.132.0，实际模型走 OpenAI 请求时入口为 `/codebuddy/default/v1/chat/completions`。本地 CLI 冒烟验证真实已安装 CLI 和模拟服务之间的协议及请求头，不替代完整真实编码任务实验。

## 本地复现与剩余验收

环境：Node 22.16+（本地验证使用 Node 23）、各子项目声明的 npm 依赖、Python 3.11+ 和 pytest。按子项目安装依赖后，从仓库根目录运行：

```bash
node scripts/verify-competition.mjs --cli --output /tmp/competition-verification.json
```

该脚本不安装依赖、不部署、不调用真实模型。包含 Core／Proxy／Panel 回归、新增模块类型检查、前端构建、Python 评测协议测试、来源导入／成本汇总测试、合成项目测试，以及可选的真实已安装 CLI → 本地模拟服务验证。没有安装 CodeBuddy CLI 时可去掉 `--cli`，报告会明确记载未覆盖 CLI。

另外提供[安装与部署整链路验收](../../deploy/quality-v2/ACCEPTANCE.md)：实际 npm 包在空目录安装并启动；真实 CLI → Proxy → Core／编排器 → 测试回执 → 自动候选回流 → 审核后下一任务复用，Panel API 可读取同一份回执。模型响应仍为确定性合成测试数据，与真实模型效果评测分开。

后续真实验收：替换或扩充原始资料；冻结资产池和模型；使用不同类型任务做有／无资产的重复配对；独立测试；等待或明确封闭后台观察窗口；采集所有模型调用成本；记录候选审核后在新任务中的复用。主办方数据、真实生成质量、任务收益和统计结论均未在本轮实验中证明。
