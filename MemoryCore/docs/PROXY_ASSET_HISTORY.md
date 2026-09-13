# Proxy 资产历史回放与压缩后卡片迁移

## 范围

不修改 CodeBuddy。实现位于 MemoryProxy 的真实 InjectionPipeline，支持 OpenAI Chat Completions / Anthropic 适配器。它维护的是 Proxy 自己追加的消息，不是另存一份客户端完整对话。正常链路为“客户端历史 → 原位回放 → 本轮推荐 → 追加新卡片 → 转发模型”。

启用后从下一次请求开始建立台账。上线前从未记录的位置无法凭空重建；已有会话可以继续使用并逐步建立记录，不把旧 Core 候选清单冒充为实际注入记录。

本功能不等于生产缓存命中率提升的实测结果，也不等于模型采用了卡片或正确完成任务。测试中的合成客户端消息与真实 CodeBuddy UI 端到端验收必须分开报告。

## 定位算法

1. 在其他注入器运行前，读取本次客户端消息。
2. 消息指纹包含角色、保持原样的内容块、工具调用/返回 ID、图片信息和 reasoning_content。对象键规范化排序，数组与文本不改写；传输 trace、轮号不参与；cache_control 不作为消息内容。
3. `H_i = SHA256(message-v1, message_i)`；`P_i = SHA256(prefix-v1, P_(i-1), H_i)`。
4. 保存实际生成的整条追加消息原文、资产 ID/revision、P_i、记录 ID、状态。下一请求只有匹配 P_i 才原位回放。重复的“继续”因完整前缀不同不会混淆。
5. 仅移除客户端回传的、与台账原文完全相同的独立 Proxy 消息，再恢复一次；摘要中的 ID、片段、引用不算完整原文。
6. 正常增长时不排序或重写旧集合。新内容只追加；不在未闭合工具调用和其结果之间插入用户消息。

## 压缩与其他历史改写

指纹变化不是压缩证明。当前识别首条非 system 用户消息中的完整 `<conversation_summary>…</conversation_summary>`、`<context_summary>…</context_summary>`、`[上下文压缩摘要]…`，以及以 `This session is being continued from a previous conversation that ran out of context.` 开头的客户端续接摘要。只有历史确实发生变化才触发迁移。

这些是明确限定的协议文本特征，不是经过认证的压缩事件；没有宣称覆盖所有 CodeBuddy 版本。其他摘要格式、摘要嵌在混合消息内部等情况按未知历史改写处理：仅保留能匹配的旧位置，本轮重新推荐，不把全部旧资产自动搬回。单纯出现“摘要”一词不会触发。

确认摘要边界后：停用旧锚点，保留审计；把本分支实际注入过且仍有权限、版本仍有效的卡片去重，在摘要消息后放成独立集合，再为它建立新锚点。不会恢复旧对话或全部正文，也不修改摘要或固定系统提示。即使本轮 ranker 没选中旧资产，它们仍可迁移。新集合一旦建立，后续原文原位回放。

普通编辑、删除、分叉不会被当成压缩；无法匹配的分支引用退出 liveRefs，保留在审计台账，不在下一次压缩时复活。

## 保留和预算

默认保留全部“已注入且有效”的资产卡片，不是全部召回候选。预算不足才按显式配置的 pinned 资产、最近在真实工具结果中观察到正文、当前问题的字面相关程度排序；同分保持原顺序。这是保留优先级，不是内容质量分数。

预算按既有 UTF-8 字节数估算，不是精确 tokenizer。历史总注入预算与本轮召回预算分开。卡片/正文必须完整容纳，不截断读取命令或正文。超预算引用仍留在当前会话 liveRefs，通过 `/asset-bridge/list` 分页检索，再精确读取；不会把它们假装成已在上下文中。正常历史增长达到预算时也不无限追加。

短 Wiki 的既有直接提供正文行为保留；正常回放保持原文，压缩迁移统一变成卡片。读取正文、正文实际进入模型请求、采用、贡献仍是不同事件。历史回放卡片从用户查询与异步评估输入中排除，不拿 Proxy 自己的文案当用户反馈。

## 工具入口与权限

沿用现有终端 curl 入口，身份由 `(space, session)` 的已初始化绑定恢复，不接受模型传入 user/team/task/URL：

- `POST /asset-bridge/list`：`{"query":"Redis","offset":0,"limit":10}`，limit 1–20。返回有效卡片、分页游标，不返回正文，不计采用。
- `POST /asset-bridge/read`：`{"asset_id":"…","revision_id":"…"}`。精确版本读取。历史引用超出 Core 64 项热清单后，可凭同一会话的持久记录刷新引用；Core 仍执行权限与发布校验。
- `POST /asset-bridge/forget`：相同 asset_id/revision_id，显式停止本会话的回放、列表与读取。保留资产和审计，不物理删除。自然语言“不要使用”没有另加模型分类器；需要明确调用此入口，不声称能自动识别所有撤回表达。

每次回放都检查当前 ACL/发布版本，不用旧权限缓存授权。隔离键包括 space/user/team/agent/task/session/client source；不同用户和任务不共享台账。旧版本不会悄悄改写成新版本，后续推荐的新版本单独记录。

## 配置、存储及恢复

```yaml
injection:
  enabled: true
  injectors: [skill, knowledge, tdai-memory, team-assets]
  teamAssets:
    enabled: true
    progressiveDisclosure: true
    historyEnabled: true
    historyDirectory: ""   # 默认 PROXY_DATA_DIR/asset-history
    historyTokenBudget: 12000
    historyPinnedAssetIds: []
```

必须在 injectors 白名单中启用 team-assets，仅设置 teamAssets.enabled 不会注册注入器。

当前存储面向单机/单容器持久卷：目录 0700、文件 0600、临时文件 fsync 后原子替换；进程内串行，同机文件锁阻止第二写入者覆盖。正常重启会恢复记录；同主机已退出进程的锁可恢复，外部主机/无法确认的锁不抢占，需要运维核验。它不是多节点一致性数据库；COS 模式明确拒绝开启此功能，应关闭 historyEnabled 或另接共享事务存储。

只保存消息指纹、Proxy 注入文本和引用，不保存客户端对话原文或认证密钥。30 天未活动的台账停止自动复用。每会话上限 512 个引用、2048 条注入记录、8 MB；达到上限报错而非悄悄删除审计，需要归档/新建会话。数据本身按运维保留策略清理。

持久化或 ACL 失败时注入管线报错，HTTP handler 现有 fail-open 分支转发原始客户端请求，不带无法确认的旧资产；不会承诺该降级请求继续保持缓存前缀。台账记录的是准备转发的上下文，模型实际接收/采用必须另以请求和评估证据确认。

## 验证

测试覆盖正常增长的原位置和序列、重复请求和客户端 echo、重复消息、原文空格、工具 ID、OpenAI/Anthropic 适配器、并发、正常重启、压缩集合迁移与后续稳定性、未知编辑不复活旧分支、权限/版本失效、预算溢出、分页检索、明确撤回、卡片不计正文 exposure。

运行：`cd MemoryProxy && npx vitest run src/assets src/injection/injectors/__tests__`。

实际缓存 hit/miss Token 与真实 CodeBuddy 的压缩消息格式需通过后续运行数据验证；不能把本次结构性回归断言换算成命中率百分比。
