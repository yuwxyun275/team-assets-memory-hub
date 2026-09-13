import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from 'tea-component';
import { MarkdownView } from '@/components/MarkdownView';
import { getLearnedSkill } from '@/lib/api/learned-skills';
import type { LearnedSkillView } from '@/lib/learned-skill';
import '../styles/skill-detail.css';

const states: Record<string, string> = { candidate: '候选，待评估', queued: '排队评估中', running: '正在评估', awaiting_approval: '待负责人审核', published: '已发布', unpublished: '当前未发布', suspended: '已暂停', needs_evidence: '待补充证据', rejected: '审核未通过', failed: '评估失败，可重试' };

export default function LearnedSkillDetailPane({ teamId, skillId, name }: { teamId: string; skillId: string; name: string }) {
  const [view, setView] = useState<LearnedSkillView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setView(null); setError('');
    void getLearnedSkill(teamId, skillId).then(value => { if (live) setView(value); }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [teamId, skillId]);
  const qualityUrl = `/quality?asset_id=${encodeURIComponent(skillId)}`;
  const content = view?.snapshot.body ?? '';
  const frontmatter = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
  const markdown = frontmatter ? content.slice(frontmatter[0].length) : content;
  return <Card className="_memory-skill-detail-card"><Card.Body className="_memory-skill-detail-body">
    <div className="_memory-skill-detail-head">
      <h2 className="_learned-skill-title">{name}</h2>
      <p className="_learned-skill-id">{skillId}</p>
      <div className="_learned-skill-actions">{view && <span className={`_learned-skill-state${view.published ? ' is-published' : ''}`}>{states[view.state] ?? view.state}</span>}<Link to={qualityUrl}>查看来源与审核／修改内容</Link></div>
    </div>
    <div className="_memory-skill-detail-scroll _learned-skill-content">
      {error ? <p role="alert">读取内容失败：{error}</p> : !view ? <p role="status">正在读取提炼的 Skill 内容…</p> : <>
        <p>{view.published ? '这份 Skill 已经审核发布，可由关联团队的任务检索使用。' : '这份 Skill 尚未发布为团队可用资产，请先在资产质量中心完成评估与审核。'}</p>
        <p>内容修订、重新评估和发布统一在资产质量中心完成。</p>
        <div className="_learned-skill-scope"><strong>适用范围</strong><p>{view.snapshot.declared_scope}</p>
          {view.snapshot.project_scope && <p>项目：{view.snapshot.project_scope.repository} · 版本：{view.snapshot.project_scope.version}</p>}
        </div>
        <h3>Skill 正文</h3>
        <MarkdownView>{markdown}</MarkdownView>
        {frontmatter && <details><summary>查看 Skill 文件头</summary><pre>{frontmatter[0]}</pre></details>}
        <h3>来源与支持材料 · {view.snapshot.sources.length} 份</h3>
        {view.snapshot.sources.map((source, i) => <details key={`${source.id}-${i}`}><summary>{source.locator || source.id}</summary>
          {source.revision && <p className="_learned-skill-id">来源版本：{source.revision}</p>}<pre>{source.content}</pre>
        </details>)}
        <p className="_learned-skill-id">内容版本：{view.snapshot.content_version}</p>
      </>}
    </div>
  </Card.Body></Card>;
}
