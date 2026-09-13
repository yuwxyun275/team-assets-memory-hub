# 第五批：Memory Hub 原生资产联合检索与逐轮场景推荐

## 1. 这一版真正解决了什么

V4 已能记录团队资产的推荐、注入、采用、验证和贡献，但线上选择器仍有一个演示性限制：
只有 `metadata_json.team_asset_bench.asset_payload` 的竞赛样例资产才能进入选择器。正常从
Memory Hub 上传或自动登记的 Wiki、Skill、Code Graph、Chat Memory 会被跳过。

V5 移除了这项限制。现在只要资产满足以下条件，就可以成为候选：

1. 资产属于当前 Team；
2. MemoryCore 对当前 User + Agent 的 `use` 权限检查通过；
3. 资产状态为 `approved`；
4. 资产类型为 Wiki、Skill、Code Graph 或 Chat Memory。

竞赛样例的旧 metadata 仍然兼容，但不再是系统运行的前提。

## 2. 为什么不把四类资产全部转成一段文本

四类资产的最佳使用方式不同：

| 资产 | 第一阶段选择 | 第二阶段实际使用 |
|---|---|---|
| Wiki | 约束/产品知识容器相关性 | 原生 Wiki 查询并按需读取相关段落、链接页 |
| Chat Memory | 历史经验容器相关性 | 原生 BM25/Embedding Hybrid Search 检索相关记忆片段 |
| Code Graph | 仓库、路径、符号和结构相关性 | 调用 `search_code`、`find_symbol`、`get_call_graph` |
| Skill | 工作流和验证能力相关性 | 按需加载 Skill，而不是把全部 Skill 正文塞进 Prompt |

因此 V5 采用“两阶段联合检索”：先在 ACL 后的资产容器中选择最相关的 3–5 个，再由各自
原生数据面读取最小片段。这样既不会绕过 MemoryCore 权限，也避免把大量无关全文注入模型。

## 3. 检索与重排链路

```text
MemoryCore User + Agent ACL / approved 硬过滤
  → 任务、当前轮问题、活动文件、最近错误画像
  → 四类资产按来源路由
  → BM25 + 稀疏向量 + 原生向量信号 + Wiki/CodeGraph 图结构信号
  → RRF 跨路排序融合
  → 可信度/新鲜度/版本/历史反馈/能力覆盖/Token 成本重排
  → 冲突与过期硬门控
  → 最小充分资产集
  → 各来源原生按需调用
  → CodeBuddy Diff、工具、测试、CI 与反馈闭环
```

当前本地稀疏向量使用 TF-IDF cosine，保证零外部模型时仍可重复；若 Memory Hub 数据面提供
Embedding 分数，系统会融合原生向量信号。Code Graph 直接复用项目现有结构索引和增量
`syncIndex`，没有为了“看起来高级”额外引入 Neo4j。

## 4. 逐轮场景推荐

MemoryProxy 现在区分两类窗口：

- **证据窗口**只包含当前人类轮次，旧编辑/测试绝不会被冒充为本轮证据；
- **检索窗口**保留当前和上一人类轮次的脱敏活动路径、工具错误，用于下一轮推荐。

因此第 5 轮出现 `CacheUnavailable` 且上一轮修改过 `feature_flags/service.py` 时，检索器能够
优先推荐与缓存回退、租户约束、相关调用图和回归流程有关的团队资产，而不是只看最初任务标题。

## 5. 原生资产适配规则

`NativeMemoryAssetAdapter` 负责把 Hub 主表转换为选择器统一控制面，但保留原生调用句柄：

- `llm_wiki` → `wiki_query`；
- `chat_memory` → `memory_hybrid_search`；
- `code_graph` → `code_graph_tool`；
- `skill` → `skill_loader`。

Hub 的名称、描述、状态、可见性、Owner、版本修订、`content_ref` 和更新时间拥有最终权威。
可选 metadata 可提供关键词、路径、测试、风险、项目版本和原生检索信号。没有这些扩展字段时
资产仍可召回，不会再次退化为“只有我们预构造的数据能测试”。

## 6. 权限与治理边界

- `asset/list-accessible(action=use)` 在 MemoryCore 执行，不在 Python 端模拟 ACL；
- 请求显式携带当前 `agent_id`，固定资产绑定和 Agent ACL 会参与判定；
- 服务端分页读取最多 1000 个权限通过的容器，避免原先 100 条截断；
- `candidate`、`rejected`、`deprecated`、过期和版本冲突资产不能注入；
- Wiki/Skill 发布默认视为 `reviewed`，Code Graph/Chat Memory 默认是 `source_verified`；
- 只有真实编辑/测试证据才能进入 `used/validated`，反事实增益成立才进入 `contributed`。

## 7. 本次实际验收

### 自动化测试

- Python 编排、评测、证据与原生适配测试：**35 项通过**；
- MemoryProxy 注入、脱敏观察和 CodeBuddy Session 测试：**15 项通过**；
- MemoryProxy V5 生产 Docker 镜像构建通过；
- V5 编排器与 Proxy 容器均健康。

### 真实 Hub 本地冒烟测试

测试场景为 CodeBuddy 第 5 轮：Redis `CacheUnavailable` 后继续处理租户安全回退，当前活动
文件是 `feature_flags/service.py`。结果：

- MemoryCore ACL 返回 4 项可使用资产；
- 原生适配成功 4/4；
- Wiki、Chat Memory、Code Graph、Skill 各选择 1 项；
- 当前活动路径进入任务画像；
- 每项回执均带运行时资产 ID、调用方式、BM25、向量、图结构和 RRF 分数；
- 本次冒烟只验证本地检索与证据协议，**没有向外部模型发送团队资产**。

编排器健康摘要：

```json
{
  "status": "ok",
  "version": "5.0",
  "native_asset_adapter": true,
  "retrieval_pipeline": "bm25+sparse-vector+native-signals+graph+rrf"
}
```

## 8. 仍需诚实说明的边界

- 当前资产容器级向量检索可零依赖运行；稠密语义向量效果取决于部署环境是否启用原生 Embedding；
- 自动测试发现仍以 Python/pytest 精品项目为主；
- 企业 GitHub/GitLab/Jenkins 可信 Webhook 协议已实现，但尚无真实公司环境联调；
- 任意原始资料自动抽取仍按此前决定暂缓，不影响正常 Hub 资产的检索与复用；
- 真实外部模型多轮统计必须在数据授权后运行，不能拿本地确定性测试冒充模型收益。

V5 的核心变化可以概括为：**以前是“为竞赛样例做选择器”，现在是“让 Memory Hub 中正常
产生和发布的团队资产直接进入可审计的逐轮复用链路”。**
