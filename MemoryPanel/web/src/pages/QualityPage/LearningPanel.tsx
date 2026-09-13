import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, FileText, FolderOpen, LockKeyhole, Upload, Users, X } from 'lucide-react';
import './learning.css';
import { Link } from 'react-router-dom';
import { metaPost } from '@/lib/api/base';

type Job = { key: string; data: { state: string; repository: string; candidate_ids: string[]; decisions?: Array<{ kind: string; asset_id?: string; reason: string }>; last_error?: string; reason?: string } };
const states: Record<string, string> = { queued: '等待检查提炼价值', running: '正在分析与对比已有资产', completed: '候选已生成，待审核', reused: '已有资产或候选可覆盖', no_candidates: '本次暂不生成候选', failed: '提炼失败，请查看材料' };
const decisions: Record<string, string> = { reuse_existing: '建议复用已有资产', duplicate_candidate: '沿用已有候选', revision_suggestion: '建议修订资产', project_experience: '项目经验', failure_pattern: '失败模式', skill_candidate: '新 Skill 候选', workflow_candidate: '新 Workflow 候选' };
export function LearningPanel({ teamId, taskId }: { teamId: string; taskId?: string }) {
  const [jobs, setJobs] = useState<Job[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [repository, setRepository] = useState(''), [version, setVersion] = useState(''), [scope, setScope] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [visibility, setVisibility] = useState('private');
  const [success, setSuccess] = useState('');
  const fieldId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const missing = [!repository.trim() && '项目路径', !version.trim() && '项目版本', !scope.trim() && '适用范围', !files.length && '原始资料'].filter(Boolean);
  const fileProblem = files.length > 24 ? '一次最多上传 24 份资料，请移除多余文件。'
    : files.some(file => file.size > 240000) ? '有文件超过 240 KB，请拆分后重新选择。' : '';
  const canSubmit = !busy && !!teamId && (taskId || (!missing.length && !fileProblem));
  const [cost, setCost] = useState<{ calls: number; input_tokens: number | null; output_tokens: number | null; missing_usage_calls: number } | null>(null);
  useEffect(() => {
    let live = true;
    setJobs([]); setCost(null); setError(''); setSuccess(''); setFiles([]);
    if (fileInput.current) fileInput.current.value = '';
    const refresh = async () => {
      const all: Job[] = []; let after: string | null = null;
      do {
        const p: { items: Job[]; next_cursor: string | null } = await metaPost('asset/quality/learning-list', { team_id: teamId, task_id: taskId, after: after ?? '' });
        all.push(...p.items); after = p.next_cursor;
      } while (after && live);
      const c = await metaPost<{ summary: NonNullable<typeof cost> }>('asset/quality/costs', { team_id: teamId, task_id: taskId });
      if (live) { setJobs(all); setCost(c.summary); }
    };
    if (teamId) void refresh().catch(e => { if (live) setError(e.message); });
    const timer = setInterval(() => { if (teamId) void refresh().catch(e => { if (live) setError(e.message); }); }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [teamId, taskId]);
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(''); setSuccess('');
    try {
      if (taskId) {
        await metaPost('asset/quality/learning-from-task', { team_id: teamId, task_id: taskId });
        setSuccess('已提交提炼请求，处理进度会显示在下方。');
      }
      else {
        if (!files.length || files.length > 24) throw new Error('请选择 1 至 24 份资料');
        const sources = await Promise.all(files.map(async (file, i) => {
          if (file.size > 240000) throw new Error(`${file.name} 太大，请拆分后上传`);
          const content = await file.text();
          if (!content.trim()) throw new Error(`${file.name} 是空文件，请选择包含正文的资料`);
          if (content.length > 60000) throw new Error(`${file.name} 超过 60,000 个字符，请按章节或模块拆分`);
          // Normal uploads are not synthetic. Explicitly tagged demonstration files
          // retain their provenance without exposing a test-only form control.
          const synthetic = /^\uFEFF?<!-- team-asset-source: synthetic -->(?:\r?\n|$)/.test(content);
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
          return { id: `source-${i + 1}`, kind: /\.jsonl$/i.test(file.name) ? 'conversation' : /\.(md|txt)$/i.test(file.name) ? 'document' : 'code',
            locator: file.name, revision: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''), content, synthetic, visibility };
        }));
        const input = { mode: 'history', repository: repository.trim(), version: version.trim(), scope: scope.trim(), sources };
        if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 140000) throw new Error('本次资料总量过大，请分批提交。包含项目信息的完整请求需在 140 KB 以内。');
        const job = await metaPost<Job>('asset/quality/learning-submit', { team_id: teamId, input });
        setJobs(current => [job, ...current.filter(item => item.key !== job.key)]);
        setSuccess('资料已提交。系统会分析内容并对比已有资产，请在下方查看提炼进度。');
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <section className={`learning-panel${taskId ? ' learning-panel-task' : ''}`}>
    <div className="learning-heading">
      <div><h2>{taskId ? '任务经验提炼' : '从原始资料学习'}</h2>
        <p>{taskId ? '任务结果、阶段验证或后续反馈形成证据后，系统异步判断是否值得提炼，优先复用或修订已有资产。证据不足时暂不生成。' : '提供项目资料，系统帮你整理可复用的经验。你只需说明资料属于哪个项目、适用于什么场景。'}</p>
      </div>
      {!taskId && <span className="learning-badge">从这里开始</span>}
    </div>
    {!taskId && <>
      <ol className="learning-flow" aria-label="资料学习流程">
        <li><span>1</span><div><strong>你提供资料</strong><small>填写下方表单</small></div></li>
        <li><ArrowRight size={16} aria-hidden="true" /><span>2</span><div><strong>系统提炼候选</strong><small>也可能建议复用已有资产</small></div></li>
        <li><ArrowRight size={16} aria-hidden="true" /><span>3</span><div><strong>负责人审核发布</strong><small>审核通过后用于团队任务</small></div></li>
      </ol>
      <form className="learning-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <div className="learning-group">
          <div className="learning-group-heading"><FolderOpen size={18} aria-hidden="true" /><h3>资料属于哪个项目？</h3><span>标有「必填」的内容都需要填写</span></div>
          <div className="learning-fields">
            <div className="learning-field">
              <label htmlFor={`${fieldId}-repository`}>项目／仓库路径 <span className="learning-required">必填</span></label>
              <input id={`${fieldId}-repository`} className="learning-input" required maxLength={1000} autoComplete="off" spellCheck={false} value={repository} onChange={e => setRepository(e.target.value)} placeholder="例如：/Users/yourname/projects/inventory" aria-describedby={`${fieldId}-repository-help`} />
              <p id={`${fieldId}-repository-help`} className="learning-help">填写运行 CodeBuddy 的项目根目录。在项目终端输入 <code>pwd</code>，复制输出的完整路径；后续任务请使用同一路径。</p>
            </div>
            <div className="learning-field">
              <label htmlFor={`${fieldId}-version`}>项目版本 <span className="learning-required">必填</span></label>
              <input id={`${fieldId}-version`} className="learning-input" required maxLength={200} autoComplete="off" value={version} onChange={e => setVersion(e.target.value)} placeholder="例如：v1 或 v1.2.0" aria-describedby={`${fieldId}-version-help`} />
              <p id={`${fieldId}-version-help`} className="learning-help">填写版本号或 Git 提交号。体验示例用 <code>v1</code>；请与后续任务的版本保持一致。</p>
            </div>
          </div>
          <div className="learning-field">
            <label htmlFor={`${fieldId}-scope`}>这些资料适用于什么场景？ <span className="learning-required">必填</span></label>
            <textarea id={`${fieldId}-scope`} className="learning-input" required rows={2} maxLength={4000} value={scope} onChange={e => setScope(e.target.value)} placeholder="例如：库存模块的重复请求处理和回归测试；适用于单进程，不适用于多实例并发。" aria-describedby={`${fieldId}-scope-help`} />
            <p id={`${fieldId}-scope-help`} className="learning-help">用一两句话说明相关模块、要解决的问题和适用限制。经验总结由系统完成。</p>
          </div>
        </div>
        <div className="learning-group">
          <div className="learning-group-heading"><Upload size={18} aria-hidden="true" /><h3>上传原始资料</h3><span className="learning-required">必填</span></div>
          <div className="learning-upload">
            <div><strong>开发记录、项目文档或代码文件</strong><p>先选一份与当前场景相关的资料即可，也可以一次选择多份。</p></div>
            <label htmlFor={`${fieldId}-files`} className="learning-file-button">{files.length ? '重新选择文件' : '选择文件'}</label>
            <input ref={fileInput} id={`${fieldId}-files`} className="learning-file-input" type="file" multiple accept=".md,.txt,.jsonl,.py,.ts,.tsx,.js,.go,.java,.rs,.sql" aria-label="原始资料" aria-describedby={`${fieldId}-files-help`} onChange={e => { setFiles(Array.from(e.target.files ?? [])); setError(''); setSuccess(''); }} />
          </div>
          <p id={`${fieldId}-files-help`} className="learning-help">支持 Markdown、TXT、JSONL 开发记录及代码文件（Python、TS/JS、Go、Java、Rust、SQL）。每次最多 24 份，单份最多 60,000 个字符；大文件请先拆分。</p>
          {files.length > 0 && <ul className="learning-files" aria-label="已选择的资料">
            {files.map((file, i) => <li key={`${file.name}-${i}`}><FileText size={16} aria-hidden="true" /><span>{file.name}</span><small>{(file.size / 1000).toFixed(1)} KB</small><button type="button" aria-label={`移除 ${file.name}`} onClick={() => { setFiles(current => current.filter((_, index) => index !== i)); if (fileInput.current) fileInput.current.value = ''; }}><X size={16} aria-hidden="true" /></button></li>)}
          </ul>}
          {fileProblem && <p role="alert" className="quality-error">{fileProblem}</p>}
        </div>
        <div className="learning-group">
          <div className="learning-group-heading"><Users size={18} aria-hidden="true" /><h3>确认谁可以查看和使用</h3></div>
          <fieldset className="learning-visibility"><legend>资料与候选的可见范围</legend>
            <label className={`learning-choice${visibility === 'private' ? ' is-selected' : ''}`}>
              <input type="radio" name={`${fieldId}-visibility`} value="private" checked={visibility === 'private'} onChange={() => setVisibility('private')} />
              <LockKeyhole size={18} aria-hidden="true" /><span><strong>仅本人</strong><small>先整理个人资料，限制其他成员访问</small></span>
            </label>
            <label className={`learning-choice${visibility === 'team' ? ' is-selected' : ''}`}>
              <input type="radio" name={`${fieldId}-visibility`} value="team" checked={visibility === 'team'} onChange={() => setVisibility('team')} />
              <Users size={18} aria-hidden="true" /><span><strong>当前团队</strong><small>允许本团队成员查看，发布仍需审核</small></span>
            </label>
          </fieldset>
        </div>
        <div className="learning-submit">
          <div><p>提交后会怎样？</p><span>系统保留来源并提炼候选。生成的内容需经负责人审核，才会发布为团队资产。</span></div>
          <button type="submit" className="quality-primary" disabled={!canSubmit} aria-describedby={`${fieldId}-missing`}>{busy ? '正在提交…' : '提交资料并提炼候选'}</button>
        </div>
        <p id={`${fieldId}-missing`} className="learning-help learning-missing" aria-live="polite">{missing.length ? `还需填写：${missing.join('、')}。` : fileProblem || '必填信息已完成，可以提交。'}</p>
      </form>
    </>}
    {taskId && <button className="quality-primary" disabled={!canSubmit} onClick={() => void submit()}>{busy ? '正在提交…' : '根据当前证据提炼'}</button>}
    {error && <p role="alert" className="quality-error">{error}</p>}
    {success && <p role="status" className="learning-success">{success}</p>}
    <div className="learning-history">
      <h3>提炼记录 <span>{jobs.length}</span></h3>
      {jobs.length === 0 && <p className="learning-help">{taskId ? '形成执行与验证证据后，可以在这里查看任务经验的提炼进度。' : '提交资料后，处理进度与候选资产会显示在这里。'}</p>}
      {jobs.map(job => <article key={job.key}>
        <strong>{states[job.data.state] ?? job.data.state}</strong><p className="learning-help">{job.data.repository}</p>
        {job.data.reason && <p>{job.data.reason}</p>}
        {job.data.decisions?.map((d, i) => <p key={i}>{decisions[d.kind] ?? d.kind}：{d.reason}{d.asset_id && !job.data.candidate_ids.includes(d.asset_id) && <> · <Link to={`/quality?asset_id=${encodeURIComponent(d.asset_id)}`}>查看关联资产</Link></>}</p>)}
        {job.data.last_error && <details><summary>{['completed', 'reused', 'no_candidates'].includes(job.data.state) ? '查看重试记录（本次已处理完成）' : '查看处理异常'}</summary><p>{job.data.last_error}</p></details>}
        {job.data.candidate_ids.map(id => <p key={id}><Link to={`/quality?asset_id=${encodeURIComponent(id)}`}>查看候选、来源与审核结果</Link></p>)}
      </article>)}
    </div>
    {cost && <details className="learning-cost"><summary>查看后台提炼与审阅用量</summary><p>后台模型调用 {cost.calls} 次；输入 {cost.input_tokens ?? '用量不完整'}，输出 {cost.output_tokens ?? '用量不完整'} Token。{cost.missing_usage_calls > 0 ? `${cost.missing_usage_calls} 次缺少上游用量。` : ''}此处统计提炼和审阅，不包含编码对话费用。</p></details>}
  </section>;
}
