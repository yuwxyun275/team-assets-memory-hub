import { useSearchParams } from 'react-router-dom';
import { LearningPanel } from './LearningPanel';
import { RevisionReview } from './RevisionReview';
import { useCallback, useEffect, useRef, useState } from 'react';
import { metaPost } from '@/lib/api/base';
import { useTeams } from '@/stores/backend';
import { useCurrentRole } from '@/services/useCurrentRole';
import { USAGE_STATES, type UsageEffectsReceipt, type UsageEffect } from '@/lib/api/usage-feedback';
import './quality.css';

type Asset = { asset_id: string; name: string; asset_type: string; version: number; status: string; description?: string; metadata_json?: string };
type Source = { id: string; kind: string; locator: string; revision?: string; repository?: string; content: string };
type RecordRow = { key: string; data: Record<string, any>; updated: number };
type Policy = { minimum_quality: number; retention_days: number; revision: number };
type ContextUtility = { revision_id: string; context: { repository: string; task_type: string; environment: string }; score: number | null; samples: number; applicability_penalty: number };
type Detail = { revisions: RecordRow[]; exposures: RecordRow[]; utility: { score: number | null; samples: number }; contextual_utility?: ContextUtility[]; publication: { revision_id: string } | null; policy: Policy };
const states: Record<string, string> = { queued: '排队中', running: '评估中', needs_evidence: '待补证据或完善内容', rejected: '未通过', awaiting_approval: '待负责人审核', published: '已发布', suspended: '已暂停', failed: '评估服务失败，可重试', observing: '持续观察中' };
const outcomes: Record<string, string> = { helpful: '有帮助', harmful: '带来问题', not_applicable: '当前环境不适用', content_error: '内容存在错误', unobserved: '未观察到足够证据' };

export function QualityPage() {
  const { activeTeamId } = useTeams();
  const [searchParams] = useSearchParams();
  const requestedAsset = searchParams.get("asset_id") || "";
  const role = useCurrentRole();
  const manager = role === 'admin' || role === 'reviewer';
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRevision, setEditingRevision] = useState(false);
  const editorRef = useRef<HTMLElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const candidateLoaded = useRef(false);
  const selectionScrolled = useRef(false);
  const [unit, setUnit] = useState('');
  const [version, setVersion] = useState('');
  const [scope, setScope] = useState('');
  const [workflowScope, setWorkflowScope] = useState<{ suggested: string; requirements: string[]; verification_status: string; origin: { repository: string; version: string } } | undefined>();
  const [projectScope, setProjectScope] = useState<{ repository: string; version: string; synthetic: boolean } | undefined>();
  const [body, setBody] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [note, setNote] = useState('');
  const [audit, setAudit] = useState<RecordRow[]>([]);
  const [rechecks, setRechecks] = useState<RecordRow[]>([]);
  const [failedUses, setFailedUses] = useState<UsageEffect[]>([]);
  const [minimum, setMinimum] = useState(80);
  const [retention, setRetention] = useState(30);
  const [policyRevision, setPolicyRevision] = useState<number | null>(null);
  const policyDirty = useRef(false);
  const generation = useRef(0);
  const asset = assets.find(a => a.asset_id === assetId);
  const call = useCallback(<T,>(action: string, data: Record<string, unknown> = {}) => metaPost<T>(`asset/quality/${action}`, { ...data, team_id: activeTeamId }), [activeTeamId]);
  const load = useCallback(async () => {
    if (!activeTeamId) return;
    const g = generation.current;
    const list: { items: Asset[] } = { items: [] };
    for (let offset = 0; ; offset += 200) {
      const page = await call<{ items: Asset[]; total: number }>('list', { offset, limit: 200 });
      list.items.push(...page.items);
      if (offset + 200 >= page.total) break;
    }
    if (g !== generation.current) return;
    setAssets(list.items);
    const policy = await call<Policy>('policy-get');
    if (g !== generation.current) return;
    if (!policyDirty.current) { setMinimum(policy.minimum_quality); setRetention(policy.retention_days); setPolicyRevision(policy.revision); }
    if (manager) {
      const failures = await call<UsageEffectsReceipt>('failed-uses');
      if (g !== generation.current) return;
      setFailedUses(failures.items);
    }
    if (assetId) {
      const d = await call<Detail>('details', { asset_id: assetId });
      if (g !== generation.current) return;
      setDetail(d);
      if (!d.revisions.length && !candidateLoaded.current) {
        const candidate = await call<{ data: { snapshot: any } }>('learning-candidate', { asset_id: assetId }).catch(() => null);
        if (g === generation.current && candidate && !candidateLoaded.current) { useSnapshot(candidate.data.snapshot); candidateLoaded.current = true; }
      }
    }
  }, [activeTeamId, assetId, call, manager]);
  useEffect(() => { generation.current++; policyDirty.current = false; setPolicyRevision(null); setAssets([]); setAssetId(requestedAsset); setDetail(null); setAudit([]); setRechecks([]); setFailedUses([]); setBody(''); setSources([]); setScope(''); setProjectScope(undefined); setWorkflowScope(undefined); setUnit(''); setVersion(''); setNote(''); setError(''); setEditorOpen(false); setEditingRevision(false); candidateLoaded.current = false; selectionScrolled.current = false; }, [activeTeamId, requestedAsset]);
  useEffect(() => {
    if (asset && detail && !selectionScrolled.current) {
      selectionScrolled.current = true;
      reviewRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [asset, detail]);
  useEffect(() => { if (editorOpen) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [editorOpen]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => load().catch(e => { if (!cancelled) setError(String(e.message)); });
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [load]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const useSnapshot = (s: any) => { setUnit(String(s.unit_id ?? '')); setVersion(String(s.content_version ?? '')); setScope(String(s.declared_scope ?? '')); setProjectScope(s.project_scope); setWorkflowScope(s.workflow_scope); setBody(String(s.body ?? '')); setSources(Array.isArray(s.sources) ? s.sources : []); };
  const selectAsset = (id: string) => {
    generation.current++; setAssetId(id); setDetail(null); setBody(''); setSources([]); setScope(''); setProjectScope(undefined); setWorkflowScope(undefined); setUnit(''); setVersion(''); setNote(''); setError(''); setEditorOpen(false); setEditingRevision(false); candidateLoaded.current = false; selectionScrolled.current = false;
  };
  const openEditor = (r?: RecordRow) => {
    candidateLoaded.current = true;
    if (r) useSnapshot(r.data.snapshot);
    setEditingRevision(!!r); setEditorOpen(true);
    if (editorOpen) editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const closeEditor = () => { setEditorOpen(false); reviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const decide = (r: RecordRow, decision: string, reviewNote: string) => run(() => call('decide', { revision_id: r.data.id, decision, note: reviewNote }));
  const submit = () => run(async () => {
    await call('submit', { expected_asset_version: asset?.version, snapshot: {
      asset_id: assetId, asset_type: asset?.asset_type, unit_id: unit, content_version: version, declared_scope: scope, project_scope: projectScope, workflow_scope: workflowScope, body, sources,
    } });
    closeEditor();
  });
  const exportDetail = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `quality-${assetId}.json`; a.click(); URL.revokeObjectURL(url);
  };
  return <main className="quality-page">
    <header><h1>资产质量中心</h1><p>把项目资料整理成可复用资产，在这里查看提炼结果、审核发布，以及任务中的使用证据。</p></header>
    {!activeTeamId ? <p>请先选择团队。</p> : <>
      {error && <p role="alert" className="quality-error">{error}</p>}
      <LearningPanel teamId={activeTeamId} />
      {manager && <section className="quality-secondary-section"><details><summary>需要人工处理的使用评估 · {failedUses.length} 项</summary>
        <p>自动调用最多尝试 3 次；定向纠错仍失败时保留材料，不把失败当作资产质量差。修复服务后可重试，或核对原始材料后提交人工评价。</p>
        {!failedUses.length && <p>当前没有待处理的使用评估。</p>}
        {failedUses.map(item => <article key={item.receipt_id}>
          <h3>{item.asset_name ?? item.asset_id} · 任务 {item.task_id}</h3>
          <p>{item.last_error ?? '旧版未细分错误'}：{item.error_details?.issues.join('；')} · 累计尝试 {item.total_attempts}/20</p>
          <p>材料保留至 {new Date(item.expires_at).toLocaleString()}；请在保留期内处理。</p>
          <button disabled={busy} onClick={() => selectAsset(item.asset_id)}>选择此资产并查看原始材料</button>
        </article>)}
      </details></section>}
      <section><h2>候选与已发布资产</h2><p>选择一项资产，查看内容、来源、审核结果和使用记录。</p>
      <label>选择资产<select value={assetId} disabled={busy} onChange={e => selectAsset(e.target.value)}>
        <option value="">请选择</option>{assets.map(a => <option key={a.asset_id} value={a.asset_id}>{a.name} · {a.asset_type} · {a.status}</option>)}
      </select></label>
      {!assets.length && <p>还没有可查看的资产。先在上方提交原始资料，生成的候选会出现在这里；也可以在 Wiki、Chat Memory、Code Graph 或 Skill 页面创建资产。</p>}
      </section>
      {asset && <>
        <section ref={reviewRef} className="quality-review-section"><h2>候选内容与审核发布</h2>
          <p>先核对正文、来源和适用范围，再由负责人审核发布。已有候选无需重新填写或提交。</p>
          {!detail && <p role="status">正在读取候选内容与审核结果…</p>}
          {detail && !detail.revisions.length && <div className="quality-empty-review"><p>这项资产还没有提交内容评估。你可以手动整理正文和支持材料，提交后再审核发布。</p><button className="quality-primary" disabled={busy} onClick={() => openEditor()}>手动提交内容</button></div>}
          {detail?.revisions.map(r => <RevisionReview key={r.key} revision={r} name={asset.name} manager={manager} busy={busy}
            onEdit={() => openEditor(r)} onRetry={() => void run(() => call('retry', { revision_id: r.data.id }))}
            onDecide={(decision, reviewNote) => void decide(r, decision, reviewNote)} />)}
          {error && <p role="alert" className="quality-error">{error}</p>}
          {!!detail?.revisions.length && <details className="quality-export"><summary>导出报告与使用证据</summary><button onClick={exportDetail}>下载 JSON 文件</button></details>}
        </section>
        {editorOpen && <section ref={editorRef} className="quality-editor" aria-label="内容编辑表单"><div className="quality-editor-heading"><h2>{editingRevision ? '修改内容并重新评估' : '手动提交内容'}</h2><button disabled={busy} onClick={closeEditor}>取消编辑，返回查看</button></div>
          <p>{editingRevision ? '已载入这份候选的正文与来源，只需修改有问题的部分。提交后会重新评估，并再次等待负责人审核。' : '填写一份具体内容及其来源，提交后系统会启动评估，通过后仍需负责人审核。'}</p>
          {editingRevision && <p className="quality-help">如果只是查看或审核，点击「取消编辑，返回查看」即可。修改原资产会使旧发布版本失效。</p>}
          <div className="quality-row"><label>内容单元标识<input value={unit} onChange={e => setUnit(e.target.value)} placeholder="例如：docs/deploy.md 或 SKILL.md" /></label>
            <label>内容版本<input value={version} onChange={e => setVersion(e.target.value)} placeholder="例如：v1.2.0 或 Git 提交号" /></label></div>
          <label>适用范围<textarea rows={2} value={scope} onChange={e => setScope(e.target.value)} placeholder="例如：库存服务的单进程重试处理；不适用于分布式并发" /></label>
          {projectScope && <p>项目：{projectScope.repository} · 版本：{projectScope.version}{projectScope.synthetic ? ' · 合成资料' : ''}</p>}
          {workflowScope && <p>建议复用范围：{workflowScope.suggested}。完整流程尚未独立验证；执行前需核对 {workflowScope.requirements.length} 项适用条件。</p>}
          <label>实际正文<textarea rows={10} value={body} onChange={e => setBody(e.target.value)} placeholder="实际知识正文，不是标题、摘要或入口链接" /></label>
          <label>导入内容快照 JSON<input type="file" accept="application/json,.json" onChange={e => { const file = e.target.files?.[0]; if (file) void run(async () => { if (file.size > 240000) throw new Error('材料超过 240 KB，请按内容单元拆分'); useSnapshot(JSON.parse(await file.text())); }); }} /></label>
          <h3>支持材料</h3><p>来源标签不等于事实已验证。请提供能够核对的原始材料；测试输出不会被当作本系统亲自执行的结果。</p>
          {sources.map((s, i) => <fieldset key={i}><legend>材料 {i + 1}</legend>
            <div className="quality-row"><label>材料标识<input placeholder="例如：source-1" value={s.id} onChange={e => setSources(v => v.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} /></label>
              <label>类型<select value={s.kind} onChange={e => setSources(v => v.map((x, j) => j === i ? { ...x, kind: e.target.value } : x))}>{['document', 'conversation', 'code', 'test_output', 'resource'].map(k => <option key={k}>{k}</option>)}</select></label></div>
            {(['locator', 'revision', 'repository'] as const).map(k => <label key={k}>{({ locator: '来源位置', revision: '来源版本', repository: '仓库标识' })[k]}<input placeholder={({ locator: '例如：docs/inventory.md 或原始文档地址', revision: '例如：v1.2.0 或 Git 提交号', repository: '例如：/Users/yourname/projects/inventory' })[k]} value={s[k] ?? ''} onChange={e => setSources(v => v.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))} /></label>)}
            <label>来源原文<textarea rows={4} placeholder="粘贴能够支持这项经验的原始文档、代码片段或测试输出" value={s.content} onChange={e => setSources(v => v.map((x, j) => j === i ? { ...x, content: e.target.value } : x))} /></label>
            <button onClick={() => setSources(v => v.filter((_, j) => j !== i))}>移除此材料</button>
          </fieldset>)}
          <div className="quality-row"><button disabled={sources.length >= 24} onClick={() => setSources(v => [...v, { id: `source-${crypto.randomUUID().slice(0, 8)}`, kind: 'document', locator: '', content: '' }])}>添加支持材料</button>
            <button className="quality-primary" disabled={busy || !unit.trim() || !version.trim() || !body.trim() || !scope.trim()} onClick={submit}>{editingRevision ? '提交修改并重新评估' : '提交内容并启动评估'}</button></div>
          {error && <p role="alert" className="quality-error">{error}</p>}
        </section>}
        <section><h2>使用观察与反馈</h2>
          <p>有效观察样本：{detail?.utility.samples ?? 0}。总览不代表所有环境下有效；实际推荐按具体版本和任务环境使用 U。</p>
          {detail?.contextual_utility?.map(u => <article key={JSON.stringify([u.revision_id, u.context])}>
            <h3>场景使用分 U：{u.score === null ? '待观察' : `${(u.score * 100).toFixed(1)} / 100`}</h3>
            <p>仓库：{u.context.repository || '未提供'} · 任务类型：{u.context.task_type || '未提供'} · 环境：{u.context.environment || '未提供'}</p>
            <p>去重有效样本：{u.samples} · 场景不适用惩罚：{(u.applicability_penalty * 100).toFixed(2)} 个百分点。U 不是成功概率，也不会覆盖内容质量 Q。</p>
            <p className="quality-id">发布版本：{u.revision_id}</p>
          </article>)}
          {!detail?.exposures.length && <p>尚无使用观察。请让关联了本团队和看板任务的 CodeBuddy 使用已发布资产。</p>}
          {!!detail?.exposures.length && <label>使用反馈说明<textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="例如：这条经验帮助补上了重复请求测试；请选择对应记录下的反馈。" /></label>}
          {detail?.exposures.map(e => <article key={e.key}><h3>任务 {e.data.task_id} · 第 {e.data.turn} 轮</h3><p>{USAGE_STATES[e.data.effect_receipt?.status] ?? states[e.data.state]} · {e.data.events.length} 条观察事件</p>
            <p>当前窗口评价：{outcomes[e.data.effect_receipt?.assessment?.outcome] ?? '尚无有效结论'}{e.data.effect_receipt?.assessment?.source === 'human' ? '（人工）' : ''}</p>
            <p>{e.data.effect_receipt?.assessment?.reason}</p>
            {e.data.last_error && <p role="status">错误：{e.data.last_error} · {e.data.error_details?.issues?.join('；')} · 本轮 {e.data.attempts}/3 次，累计 {e.data.total_attempts ?? 0}/20 次。</p>}
            {e.data.state === 'failed' && <button disabled={busy || !note.trim() || (e.data.total_attempts ?? 0) >= 20} onClick={() => void run(() => call('retry-use', { exposure_id: e.key, note }))}>按说明重新评估（累计最多 20 次）</button>}
            <details><summary>查看失败及重试历史</summary><pre>{JSON.stringify({ errors: e.data.error_history ?? [], correction: e.data.repair_feedback, retries: e.data.retry_requests ?? [], previous_assessments: e.data.assessment_history ?? [] }, null, 2)}</pre></details>
            <details><summary>查看注入片段、后续事件与证据引用</summary><pre>{JSON.stringify({ injected: e.data.injected_text, context: e.data.context, events: e.data.events, citations: e.data.assessment?.citations }, null, 2)}</pre></details>
            <div className="quality-row">{Object.entries(outcomes).map(([value, title]) => <button disabled={busy || !note.trim()} key={value} onClick={() => void run(() => call('feedback', { exposure_id: e.key, outcome: value, note }))}>{title}</button>)}</div>
            {manager && <button disabled={busy} onClick={() => { if (window.confirm('删除这条观察的原文及效果记录？此操作无法在页面撤销。')) void run(() => call('delete-evidence', { exposure_id: e.key })); }}>删除观察数据及其效果记录</button>}
          </article>)}
        </section>
      </>}
      {manager && <section className="quality-secondary-section"><details><summary>团队策略与审计（管理员设置）</summary><p>人工审核始终启用。阈值属于试验参数，不代表已经完成准确率校准；修改策略后待发布版本必须按新策略重评。</p>
        <div className="quality-row"><label>最低 Q<input type="number" min={0} max={100} value={minimum} onChange={e => { policyDirty.current = true; setMinimum(Number(e.target.value)); }} /></label><label>会话证据保留天数<input type="number" min={1} max={365} value={retention} onChange={e => { policyDirty.current = true; setRetention(Number(e.target.value)); }} /></label></div>
        <label>策略变更说明<textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="至少 8 字，说明修改依据" /></label>
        <button disabled={busy || policyRevision === null || note.trim().length < 8} onClick={() => void run(async () => { await call('policy-set', { policy: { expected_revision: policyRevision, minimum_quality: minimum, retention_days: retention, note } }); policyDirty.current = false; })}>保存团队策略</button>
        <button disabled={busy} onClick={() => void run(async () => { policyDirty.current = false; })}>重新载入团队策略</button>
        <button disabled={busy} onClick={() => void run(async () => { setAudit((await call<{ items: RecordRow[] }>('audit')).items); setRechecks((await call<{ items: RecordRow[] }>('rechecks')).items); })}>读取审计及内容复评请求</button>
        {rechecks.map(r => <p key={r.key}>待处理复评：{r.data.asset_id} · {r.data.note}</p>)}
        {audit.map(r => <p key={r.key}>{new Date(r.updated).toLocaleString()} · {r.data.actor} · {r.data.action} · {r.data.note}</p>)}
      </details></section>}
    </>}
  </main>;
}
