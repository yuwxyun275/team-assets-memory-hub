# 缓存注入位置隔离实验

只测试同一资产文本的注入位置，使用真实 DeepSeek API `usage`，不把字符串共同前缀长度当成缓存命中数。不会更改正式 Proxy 配置、资产状态或真实用户会话。

## 方法

- 使用当前运行容器的真实 `InjectionPipeline` 和 `OpenAIAdapter`，构造 `system.suffix` 与 `context.tail` 两组请求。
- 对照组为系统提示词末尾、历史之前注入，是重建基线，并非旧版本整个程序回放。
- 负载完全由 `synthetic-fixture.mjs` 新编：虚构代码、Wiki、Memory、Graph 和 Skill。发送内容不读取项目源代码或已有资产。
- 固定全文，不混入卡片的内容缩減；资产不变、排序变化、排序变化伴随压缩三场景，各两次六轮重复，共 72 个主对照请求，另有 2–3 个相同请求校准。
- `deepseek-v4-flash`，非思考、temperature=0、max_tokens=16。独立 user_id 隔离各组缓存，配对请求顺序交替，同组间隔至少 6 秒。
- 记录原始上游 usage；使用 Token 加权命中率。输入 = 命中 + 未命中。字段缺失、总数不一致、请求失败即中止并保存部分数据，不自动付费重试。
- 1,000,000 累计输入 Token 预算，下一请求额外使用字节数上界裕量检查；最多 76 次调用。密钥只在容器进程中从已配置 Proxy 读取，不导出或写入结果。

## 运行

```sh
node --experimental-strip-types --test evaluation/cache_injection_bench/fixture.test.ts
node evaluation/cache_injection_bench/run.mjs
node evaluation/cache_injection_bench/run.mjs --live
node evaluation/cache_injection_bench/run.mjs --live --long-prefix
node evaluation/cache_injection_bench/report.mjs output/cache-injection-bench/<run-id>
```

`--live` 会调用外部模型并产生费用，需有用户授权与执行环境批准。默认仅校验请求，不调用外部模型。

运行结果在 `output/cache-injection-bench/<run-id>`；运行时临时脚本从容器内指定 `/tmp/cache-<timestamp>` 目录清理，结果保留在宿主机。原始请求不含真实项目数据及密钥。

## 边界

此微基准不是实际 CodeBuddy UI 会话抓包，不运行真实改码任务，也不评测自主按需读取或任务正确性。模拟客户端不把 Proxy 私自追加的资产后缀写回历史；客户端若持久化后缀，或实际工具返回完整正文进入历史，缓存行为会变化。全量生产命中率需要在正常流量中另行观测。

一次温缓存高命中不能代替多轮动态实验；固定资产场景不能省略。服务端缓存为尽力而为，调度、淘汰、压缩及其他注入器均会影响结果。报告保留不利场景和两次重复，不将此结果泛化为无条件性能承诺。
