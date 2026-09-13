/**
 * 从任务文字生成“候选”验收标准。
 *
 * 这里刻意只做可解释的确定性分析，不把候选包装成已经确认的业务事实。
 * CodeBuddy/CI 后续会把候选映射到真实测试；团队成员仍可在任务详情中确认、
 * 修改或忽略这些建议。
 */

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

export function suggestAcceptanceCriteria(title: string, description: string): string[] {
  const text = `${title}\n${description}`.trim().toLowerCase();
  if (!text) return [];

  const result: string[] = [];
  const isBug = includesAny(text, ['修复', '故障', '异常', '报错', '失败', '超时', '5xx', 'bug', 'fix']);
  const isFeature = includesAny(text, ['新增', '实现', '支持', '功能', 'feature']);
  const isCache = includesAny(text, ['redis', '缓存', 'cache']);
  const isTenant = includesAny(text, ['租户', 'tenant', '权限', '越权', '泄漏', '隔离']);
  const isTimeout = includesAny(text, ['超时', 'timeout', '5xx', '不可用', '故障']);
  // “数据库/MySQL”也可能只是读取来源，不能据此推断写入一致性要求。
  const isDataWrite = includesAny(text, ['写入', '更新记录', '删除', '保存', 'insert', 'update', 'delete', '事务']);

  if (isBug) {
    result.push('问题场景能够被稳定复现，修复后原问题不再出现');
  } else if (isFeature) {
    result.push('任务描述中的目标功能在正常输入下可用，并有可重复的验证证据');
  } else {
    result.push('任务描述中的目标结果能够被重复验证');
  }

  if (isCache && isTimeout) {
    result.push('缓存不可用或超时时，服务能够安全降级且不会产生未处理的 5xx');
    result.push('缓存恢复后重新使用正常路径，不把故障期结果长期污染为正常结果');
  }
  if (isTenant) {
    result.push('任何异常与降级路径都保持权限边界，不读取或返回其他租户的数据');
  }
  if (isDataWrite) {
    result.push('失败与重试不会造成重复写入、部分提交或数据不一致');
  }

  result.push('受影响模块的现有自动化测试与回归检查保持通过');
  result.push('新增或改变的关键行为有自动化测试覆盖；无法自动化的部分明确标记为待人工确认');
  return unique(result).slice(0, 5);
}
