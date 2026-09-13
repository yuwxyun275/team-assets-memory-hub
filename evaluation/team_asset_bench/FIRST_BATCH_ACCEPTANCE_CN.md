# 第一批：任务驱动与真实证据链验收说明

## 这批解决了什么

第一批把此前演示中最容易混淆的四个环节改成了真实、可区分的系统行为：

1. **任务看板是任务语义的权威来源。** CodeBuddy 绑定 Task 后，MemoryProxy 将 Task 名称和描述同时提供给模型与团队资产编排器。用户可以只说“开始执行”，不需要再复制一遍任务描述。
2. **任务画像由系统生成。** `task_type`、仓库、版本、候选路径、所需资产能力、资产数量上限和 Token 预算不再直接照抄演示 `task.json`。系统优先读取 Memory Hub Task 元数据，再结合当前请求和可访问资产推断，并保留每个字段的来源。
3. **`selected` 不再冒充 `injected`。** 编排器完成筛选时只写 `selected`。只有 MemoryProxy 已把团队资产区块应用到实际请求上下文后，才通过 `/v1/evidence/injected` 写入 `injected`，并保存上下文哈希、协议、注入点和请求 Trace；不保存 Prompt 正文或业务 Key。
4. **资产与修改、测试逐项绑定。** 编辑工具只上报改动哈希和文件路径，不上传源码；`validated` 必须匹配该资产声明的具体测试名。泛化的“9 passed”只能证明测试套件成功，不能证明每一项资产都有效。

## 从 0 到 1 的运行链路

```text
Memory Hub Task 名称/描述
        + 当前 CodeBuddy 请求
        + 当前用户有权使用的 Wiki / Chat Memory / Code Graph / Skill
                              ↓
自动任务画像（类型、版本、路径、能力、预算；每项带来源）
                              ↓
recalled → selected
                              ↓
MemoryProxy 真正写入请求上下文 → injected
                              ↓
模型声明 asset → decision/target + 实际 edit/test 工具调用 → used
                              ↓
资产要求的具体 test_id 执行成功 → validated
                              ↓
独立反事实结果证明增益 → contributed
```

## 用户在哪里看

Memory Hub 的任务详情抽屉会显示：

- “系统如何理解本次任务”：自动任务画像的值和来源；
- 六阶段计数：召回、筛选、注入、采用、验证、贡献；
- 每项资产的来源、贡献者、版本、风险；
- 影响的决策与代码位置；
- 对应的验证引用与反事实贡献引用；
- 任务回流候选资产的发布/拒绝入口。

## 自动验收

```bash
cd evaluation/team_asset_bench
python3 -m pytest -q
python3 -m team_asset_bench evaluate

cd ../../MemoryProxy
npm test
```

关键回归断言包括：

- 只筛选、未收到 Proxy 回执时，状态停留在 `selected`；
- Proxy post-apply 回调后才进入 `injected`；
- “开始执行”时仍使用任务看板的完整中文描述生成画像；
- 自动识别 Bug Fix、高风险团队约束、Code Graph 候选路径和动态预算；
- 未出现具体测试名的泛化成功摘要不能把资产推进到 `validated`；
- 补丁正文不会进入证据服务，只有 SHA-256 与变更路径。

## 安全边界

- 编排服务只接收 Proxy 自己的 service token，不接收或转发用户的 `sk-mem-…` 业务 Key；
- 业务 Key 仍只用于 MemoryProxy/MemoryCore 的用户鉴权；
- 日志和证据不记录完整 Key、完整 Prompt、补丁正文；
- 旧 `uky-…` Key 不在任何新流程中使用。
