import { useId, useState } from 'react';

type Revision = { key: string; data: Record<string, any>; updated: number };
const states: Record<string, string> = { queued: '排队中', running: '评估中', needs_evidence: '待补证据或完善内容', rejected: '未通过', awaiting_approval: '待负责人审核', published: '已发布', suspended: '已暂停', failed: '评估服务失败，可重试' };
const sourceKinds: Record<string, string> = { document: '文档', conversation: '开发会话', code: '代码', test_output: '测试输出', resource: '资源' };

export function RevisionReview({ revision, name, manager, busy, onEdit, onRetry, onDecide }: {
  revision: Revision; name: string; manager: boolean; busy: boolean;
  onEdit: () => void; onRetry: () => void; onDecide: (decision: string, note: string) => void;
}) {
  const [note, setNote] = useState('');
  const noteId = useId();
  const r = revision.data;
  const snapshot = r.snapshot;
  const awaitingApproval = r.state === 'awaiting_approval';
  const reviewHint = awaitingApproval
    ? '自动评估已完成。请核对下面的正文、来源和适用范围，再填写审核说明并发布。'
    : r.state === 'published' ? '此版本已发布，可用于团队任务。后续采用和验证情况见下方使用记录。'
    : ['queued', 'running'].includes(r.state) ? '系统正在评估这份内容，结果会自动更新。你可以先查看正文和来源。'
    : '请查看自动评估结果；需要补充或修正内容时，点击「修改内容」。';

  return <article className="quality-revision">
    <div className="quality-revision-heading"><h3>{name}</h3><span className={`quality-status quality-status-${r.state}`}>{states[r.state] ?? r.state}</span></div>
    <p className="quality-review-hint">{reviewHint}</p>
    <h4 className="quality-step">1. 核对内容与来源</h4>
    <div className="quality-snapshot-info">
      <strong>适用范围</strong><p>{snapshot.declared_scope || '未提供适用范围'}</p>
      {snapshot.project_scope && <p>适用项目：{snapshot.project_scope.repository} · 项目版本：{snapshot.project_scope.version}{snapshot.project_scope.synthetic ? ' · 合成资料' : ''}</p>}
      {snapshot.workflow_scope && <details><summary>流程适用范围与验证边界</summary>
        <p>建议范围：{snapshot.workflow_scope.suggested}；来源：{snapshot.workflow_scope.origin.repository} @ {snapshot.workflow_scope.origin.version}</p>
        <p>尚无本候选完整流程的独立执行验证。后续使用结果见下方使用观察与任务回执，不能将来源任务成功当作跨项目证明。</p>
        <ul>{snapshot.workflow_scope.requirements.map((v: string, i: number) => <li key={i}>{v}</li>)}</ul>
      </details>}
    </div>
    <div className="quality-readonly" role="region" aria-label="候选正文"><h4>正文 <span>只读预览</span></h4><pre tabIndex={0}>{snapshot.body || '未提供正文'}</pre></div>
    <div className="quality-source-list" role="region" aria-label="资产来源">
      <h4>来源与支持材料 <span>{snapshot.sources?.length ?? 0} 份</span></h4>
      <p className="quality-help">展开材料可核对原文。上传的测试输出属于来源证据，不代表系统已经执行验证。</p>
      {!snapshot.sources?.length && <p>未提供来源材料。</p>}
      {snapshot.sources?.map((source: any, i: number) => <details key={`${source.id}-${i}`}>
        <summary>{source.locator || source.id} <span>· {sourceKinds[source.kind] ?? source.kind}</span></summary>
        <p className="quality-id">材料标识：{source.id}{source.revision ? ` · 来源版本：${source.revision}` : ''}{source.repository ? ` · 仓库：${source.repository}` : ''}</p>
        <pre tabIndex={0}>{source.content}</pre>
      </details>)}
    </div>
    <details className="quality-report"><summary>查看自动评估详情</summary>
      <p>内容质量：{r.report?.scorecard?.quality ?? '待核实'} / 100 · 证据覆盖：{r.report?.scorecard?.evidence_coverage ?? 0}% · 发布门槛：{r.policy.minimum_quality}，且必需检查全部通过</p>
      <p className="quality-id">内容标识：{snapshot.unit_id} · 内容版本：{snapshot.content_version} · 源资产版本：{r.expected_version}</p>
      <p className="quality-id">评估版本：{r.id} · 尝试：{r.attempts}/3</p>
      {r.report?.checks.map((c: any) => <details key={c.id}><summary>{c.label} · {({ pass: '通过', fail: '发现缺陷', unknown: '待核实' } as Record<string, string>)[c.status]} · {c.score ?? '—'}/4</summary>
        <p>{c.reason}</p>{c.remediation && <p>建议：{c.remediation}</p>}{c.evidence.map((e: any, i: number) => <blockquote key={i}><small>{e.source_id} · 字符 {e.start}–{e.end}</small><pre>{e.quote}</pre></blockquote>)}
      </details>)}
    </details>
    {r.last_error && <p role="status">{r.last_error}：评估失败不等于资产差，也不代表允许发布。</p>}
    {awaitingApproval && <div className="quality-approval">
      <h4 className="quality-step">2. 填写审核说明并发布</h4>
      {manager ? <>
        <label htmlFor={noteId}>审核说明 <span className="quality-required">必填</span></label>
        <textarea id={noteId} rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="例如：已核对来源与正文，适用范围清楚，同意在所述范围内发布。" aria-describedby={`${noteId}-help`} />
        <p id={`${noteId}-help`} className="quality-help">{note.trim() ? '发布后，这份内容才能作为团队资产供任务使用。' : '填写你核对的依据后，即可点击发布；不需要重新提交正文。'}</p>
        <div className="quality-row"><button className="quality-primary" disabled={busy || !note.trim()} onClick={() => onDecide('approve', note)}>确认依据并发布</button><button disabled={busy || !note.trim()} onClick={() => onDecide('reject', note)}>拒绝发布</button></div>
      </> : <p>请由团队负责人或审核人员完成发布审核，你可以先核对上面的内容。</p>}
    </div>}
    <div className="quality-edit-entry"><div><strong>发现内容需要调整？</strong><p className="quality-help">修改后需重新评估；只查看和审核时，无需进入编辑。</p></div><button disabled={busy} onClick={onEdit}>修改内容</button></div>
    {['failed', 'needs_evidence'].includes(r.state) && <button disabled={busy} onClick={onRetry}>重试评估</button>}
    {manager && r.state === 'published' && <details><summary>暂停此版本</summary>
      <label>暂停说明<textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="例如：发现此版本与当前环境不兼容，先暂停使用。" /></label>
      <button disabled={busy || !note.trim()} onClick={() => onDecide('suspend', note)}>暂停该版本</button>
    </details>}
  </article>;
}
