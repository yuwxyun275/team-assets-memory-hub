import type { QualitySnapshot } from "../types.js";

/** Synthetic, curated fixtures. Not a live-model evaluation or production evidence. */
export function snapshot(type: QualitySnapshot["asset_type"] = "llm_wiki"): QualitySnapshot {
  const base: QualitySnapshot = {
    asset_id: "asset-1", unit_id: "unit-1", asset_type: type, content_version: "v1",
    declared_scope: "示例 feature_flags 项目 v1：多租户缓存读取；不适用于缓存写入。",
    body: "Redis 不可用时仅回退一次数据库，查询必须带 tenant_id 且只读已发布记录；恢复后重新读缓存。",
    sources: [{ id: "reference", kind: "document", locator: "design.md", revision: "v1", content: "设计依据：每次请求最多进行一次缓存查询，出现 CacheUnavailable 后以 tenant_id 和 published=true 查询数据库。禁止自动重试。" }],
  };
  if (type === "skill") {
    base.body = "---\nname: cache-fault-recovery\ndescription: 验证示例服务缓存故障与恢复\n---\n\n仅在示例项目 v1 的隔离测试环境运行。先运行正常缓存测试，再模拟 CacheUnavailable，确认只回退一次且租户隔离。解除故障后验证请求重新走缓存；断言失败立即停止，不修改生产配置。";
  }
  if (type === "chat_memory") {
    base.body = "用户确认在示例项目 v1 的缓存读取路径禁止请求内重试；这不是对其他系统的通用要求。";
    base.sources = [{ id: "conversation", kind: "conversation", locator: "session-demo/turn-3", content: "user: 我们这个项目的 Redis 读取不允许同一请求重试，直接安全降级。assistant: 我会按这个约束检查。" }];
  }
  if (type === "code_graph") {
    base.body = JSON.stringify({ repository: "example/flags", revision: "v1", nodes: [{ id: "get", source_id: "code", path: "service.py", symbol: "get_flag", start_line: 1, end_line: 2 }], edges: [] });
    base.sources = [{ id: "code", kind: "code", locator: "service.py", revision: "v1", repository: "example/flags", content: "def get_flag(tenant_id, key):\n    return cache.get(tenant_id, key)\n" }];
    base.declared_scope = "example/flags v1 service.py get_flag 定义节点切片，不声明调用边完整性。";
  }
  return base;
}
