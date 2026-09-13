import { useEffect, useState } from 'react';
import { taskUsageReceipt, USAGE_OUTCOMES, USAGE_STATES, APPLICABILITY_LABELS, type UsageEffectsReceipt } from '@/lib/api/usage-feedback';

/** Separate from trusted engineering state: a model's helpful verdict is not CI or causal proof. */
export function UsageEffectReceipts({ teamId, taskId }: { teamId: string; taskId: string }) {
  const [receipt, setReceipt] = useState<UsageEffectsReceipt | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, pending = false;
    setReceipt(null); setError('');
    const refresh = async () => {
      if (pending || !teamId || !taskId) return;
      pending = true;
      try { const data = await taskUsageReceipt(teamId, taskId); if (!cancelled) { setReceipt(data); setError(''); } }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [teamId, taskId]);
  return <section className="_memory-usage-receipts" aria-label="资产使用效果回执">
    <h3>资产使用效果回执（异步评估）</h3>
    <p>推荐前的条件用于判断适用性，正文送达后的行为用于判断效果。两项分别评估，不替代实际采用、独立测试和贡献证明。</p>
    {error && <p role="alert">回执读取失败：{error}。当前不是“零效果”，请稍后重试。</p>}
    {!error && !receipt && <p role="status">正在读取效果回执…</p>}
    {receipt && <>
      <p>资产版本 {receipt.summary.assets} · 去重观察 {receipt.summary.observations} · 已评价 {receipt.summary.assessed} · 有帮助 {receipt.summary.helpful} · 待人工 {receipt.summary.manual_review}</p>
      {!receipt.items.length && <p>尚无当前账号可见的使用效果记录；不代表没有召回卡片或资产无效。</p>}
      {receipt.items.map(item => <details key={item.receipt_id} className="_memory-asset-card" open>
        <summary><strong>{item.asset_name ?? item.asset_id}</strong> · {USAGE_STATES[item.status] ?? item.status}</summary>
        {item.recommendation_scene ? <>
          <p><strong>① 推荐前的场景</strong> · 第 {item.recommendation_scene.turn} 轮</p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{item.recommendation_scene.query || item.recommendation_scene.task}</p>
          <p><strong>当时是否适用：</strong>{item.applicability ? APPLICABILITY_LABELS[item.applicability.verdict] : '等待后台核对'}</p>
          {item.applicability && <>
            <p>{item.applicability.reason}</p>
            {item.applicability.asset_quote && <blockquote>资产条件：{item.applicability.asset_quote}</blockquote>}
            {item.applicability.citations.map((c, i) => <blockquote key={`before-${i}`}>
              <small>推荐前证据 · {c.event_id}</small><p style={{ whiteSpace: 'pre-wrap' }}>{c.quote}</p>
            </blockquote>)}
          </>}
          <details><summary>快照与观察边界</summary>
            <p>冻结请求 {item.recommendation_scene.request_id}<br />快照校验 {item.recommendation_scene.hash}</p>
            <p>{item.recommendation_scene.truncated ? '保留了有界片段，不代表完整历史。未保留内容不能作为本次评估证据。' : '使用推荐时保存的片段，不根据任务结果倒推当时的需求。'}</p>
          </details>
        </> : <p>该历史记录未保存推荐前场景，不参与新的相似场景学习。</p>}
        <p><strong>② 正文送达后的实际效果</strong></p>
        <p>{item.assessment ? `${item.assessment.source === 'human' ? '人工评价' : '模型评价'}：${USAGE_OUTCOMES[item.assessment.outcome] ?? item.assessment.outcome}` : '当前观察窗口尚无有效评价'}</p>
        {item.assessment && <p>{item.assessment.reason}</p>}
        {item.assessment?.asset_quote && <blockquote><small>对应的当前资产原文</small><p style={{ whiteSpace: 'pre-wrap' }}>{item.assessment.asset_quote}</p></blockquote>}
        {item.observation_window?.closed && <p role="status">本次观察窗口已达到容量上限，已保留 {item.observation_window.events} 条事件；后续未纳入的事件不在本次评价范围内。</p>}
        {item.last_error && !item.assessment && <p role="status">错误：{item.last_error} · 本轮尝试 {item.attempts}/3，累计 {item.total_attempts}/20。{item.error_details?.issues.join('；')} 可前往资产质量中心处理。</p>}
        {item.citations.map((citation, index) => <blockquote key={`${citation.event_id}-${index}`}>
          <small>证据 {citation.event_id} · {citation.role ?? '未知来源'}{citation.tool_call_id ? ` · 工具调用 ${citation.tool_call_id}` : ''}</small>
          <p style={{ whiteSpace: 'pre-wrap' }}>{citation.quote}</p>
        </blockquote>)}
        {item.scene_feedback && <div>
          <p><strong>③ 相似场景下的推荐反馈</strong></p>
          <p>使用效果 U：{item.scene_feedback.score == null ? '未知（没有正负效果样本）' : `${(item.scene_feedback.score * 100).toFixed(1)}/100`} · 效果样本 {item.scene_feedback.samples}</p>
          <p>适用性修正值：{item.scene_feedback.applicability_adjustment.toFixed(4)} · 有效适用性任务 {item.scene_feedback.scene_learning?.fit_tasks ?? 0}/{item.scene_feedback.scene_learning?.minimum_fit_tasks ?? 3}</p>
          <p>仅同仓库、环境、任务类型和资产版本下的相似问题参与。未达到 3 个独立任务时，不启用适用性修正。它不是质量分，不改 Q 和旧版正文。</p>
        </div>}
        <small className="_memory-usage-reference">资产 {item.asset_id} · 发布版本 {item.revision_id}<br />会话 {item.session_id} · 更新 {new Date(item.updated_at).toLocaleString()} · 证据保留至 {new Date(item.expires_at).toLocaleString()}</small>
      </details>)}
    </>}
  </section>;
}
