import { useNavigate } from 'react-router-dom';
import { LearningPanel } from '@/pages/QualityPage/LearningPanel';
/**
 * TaskDetail —— 工作台任务详情（编辑标题/描述、切换状态、查看参与者、删除）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Segment, Text } from 'tea-component';
import { DeleteIcon, EditIcon, UserIcon, UsergroupIcon } from 'tea-icons-react';
import { canEditTask, type Task, type TaskAcceptanceContract, type Team } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { assetsApi } from '@/lib/api/assets';
import { suggestAcceptanceCriteria } from '@/lib/acceptance-suggestions';
import { UsageEffectReceipts } from './UsageEffectReceipts';
import { useStatusLabels, type AgentOption, type TaskParticipationView } from '../utils/workbench-utils';

const ASSET_FLOW = ['recalled', 'selected', 'injected', 'used', 'validated', 'contributed'] as const;
const ASSET_FLOW_LABELS: Record<(typeof ASSET_FLOW)[number], string> = {
  recalled: '召回',
  selected: '筛选',
  injected: '注入',
  used: '采用',
  validated: '验证',
  contributed: '贡献',
};
const SOURCE_LABELS: Record<string, string> = {
  wiki: 'Wiki 项目约束',
  chat_memory: '历史 Session 经验',
  code_graph: 'Code Graph 代码知识',
  skill: 'Skill 验证流程',
};

interface AssetEvidenceItem {
  asset_id: string;
  runtime_asset_id?: string;
  title: string;
  source_type: string;
  asset_type?: string;
  contributor?: string;
  source_ref?: string;
  version?: string;
  updated_at?: string;
  evidence_state?: string;
  states: string[];
  score?: number;
  decision?: string;
  target?: string;
  validation?: string;
  validation_ref?: string;
  attribution?: {
    confidence?: number;
    grade?: 'strong' | 'moderate' | 'weak' | string;
    observed_action?: {
      tool_name?: string;
      kind?: string;
      changed_paths?: string[];
      matched_paths?: string[];
    };
    validation?: {
      matched_tests?: string[];
      test_specificity?: number;
      independent_evidence?: boolean;
    };
  };
  contribution_ref?: string;
  risk?: string;
  risks?: string[];
  risk_flags?: {
    expired?: boolean;
    conflict?: boolean;
    low_confidence?: boolean;
    version_incompatible?: boolean;
  };
}

interface CandidateAssetReceipt {
  asset_id: string;
  title: string;
  status: string;
  source_trace_id?: string;
  source_task_id?: string;
  verification?: string;
  review_required?: boolean;
}

interface AssetFeedbackReceipt {
  asset_id?: string;
  signal?: 'useful' | 'not_applicable' | 'duplicate' | 'ignored' | 'stale' | 'incorrect' | 'unobserved'
    | 'accepted' | 'used' | 'validated' | 'contributed' | 'corrected' | string;
  source?: string;
  reason?: string;
}

interface CiRunReceipt {
  run_id?: string;
  provider?: string;
  status?: 'passed' | 'failed' | string;
  evidence_ref?: string;
  execution_origin?: string;
  regression_proof?: {
    mode?: string;
    confirmed?: boolean;
    baseline_status?: 'passed' | 'failed' | string;
    patched_status?: 'passed' | 'failed' | string;
    transitions?: Array<{
      check_id?: string;
      before?: 'passed' | 'failed' | string;
      after?: 'passed' | 'failed' | string;
    }>;
    baseline_run_id?: string;
    patched_run_id?: string;
  };
  regression_pair?: {
    role?: 'baseline' | 'patched' | string;
    paired_run_id?: string;
    confirmed?: boolean;
  };
  checks?: Array<{
    check_id?: string;
    name?: string;
    status?: 'passed' | 'failed' | string;
    source?: string;
    test_ids?: string[];
    summary?: string;
    evidence_ref?: string;
    duration_ms?: number;
  }>;
  verification_discovery?: {
    frameworks?: string[];
    ci_providers?: string[];
    config_files?: string[];
    acceptance_coverage?: Array<{
      criterion_id?: string;
      text?: string;
      status?: 'mapped_candidate' | 'coverage_gap' | string;
      mapped_test_ids?: string[];
      confidence?: number;
      reason?: string;
    }>;
    discovery_warnings?: string[];
  };
}

interface AcceptancePlanReceipt {
  status?: 'proposed' | 'not_requested' | string;
  generated_by?: string;
  context_sources?: string[];
  safety?: {
    planner_can_validate?: boolean;
    requires_trusted_ci?: boolean;
    external_model_used?: boolean;
  };
  criteria?: Array<{
    criterion_id?: string;
    text?: string;
    category?: string;
    rationale?: string;
    source_asset_ids?: string[];
    source_titles?: string[];
    target_paths?: string[];
    candidate_test_ids?: string[];
    verification_method?: string;
    confidence?: number;
  }>;
}

interface TurnEvidenceReceipt {
  turn_id: string;
  trace_id: string;
  turn_seq: number;
  query_preview?: string;
  status?: string;
  summary?: Record<string, number>;
  selected_assets?: Array<{
    asset_id?: string;
    title?: string;
    source_type?: string;
    states?: string[];
  }>;
  feedback?: AssetFeedbackReceipt[];
  ci_runs?: CiRunReceipt[];
  acceptance_plan?: AcceptancePlanReceipt;
}

interface AssetEvidenceReceipt {
  trace_id: string;
  generated_at?: string;
  strategy?: string;
  token_cost?: number;
  authority?: string;
  summary?: Record<string, number>;
  assets: AssetEvidenceItem[];
  session_id?: string;
  active_evidence_trace_id?: string;
  latest_trace_id?: string;
  dynamic_retrieval?: boolean;
  turns?: TurnEvidenceReceipt[];
  latest_turn?: TurnEvidenceReceipt | null;
  session_summary?: Record<string, number>;
  feedback?: AssetFeedbackReceipt[];
  ci_runs?: CiRunReceipt[];
  acceptance_plan?: AcceptancePlanReceipt;
  candidates?: CandidateAssetReceipt[];
  task_profile?: Record<string, {
    source?: string;
    value?: unknown;
    reason?: string;
    reasons?: unknown;
    ceiling?: number;
  }>;
  acceptance_contract?: {
    require_code_change?: boolean;
    criteria?: string[];
    suggested_criteria?: string[];
    criteria_status?: 'not_requested' | 'proposed' | 'confirmed' | 'not_required' | string;
    generated_by?: string;
    verification_policy?: 'trusted_ci' | 'observed_tool' | string;
  };
  completion?: {
    status?: 'pending' | 'in_progress' | 'completed';
    task_completed?: boolean;
    completion_state?: 'pending' | 'engineering_failed' | 'engineering_completed_business_pending' | 'completed' | string;
    engineering_complete?: boolean;
    business_acceptance_complete?: boolean;
    business_acceptance_status?: 'not_defined' | 'proposed' | 'pending' | 'passed' | 'not_required' | string;
    acceptance_status?: 'not_requested' | 'proposed' | 'confirmed' | 'not_required' | string;
    contract_source?: string;
    checks?: Record<string, boolean>;
    selected_assets?: number;
    used_assets?: number;
    validated_assets?: number;
    required_tests?: string[];
    passed_tests?: string[];
    failed_tests?: string[];
    missing_tests?: string[];
    test_progress?: { passed?: number; total?: number };
    criterion_progress?: { passed?: number; total?: number };
    criterion_results?: Array<{
      criterion_id: string;
      text: string;
      status: 'passed' | 'failed' | 'pending' | 'manual_review';
      reason?: string;
      test_ids?: string[];
      targets?: string[];
      matched_paths?: string[];
      evidence_refs?: string[];
      note?: string;
      mapping_source?: string;
    }>;
    changed_paths?: string[];
    target_paths?: string[];
  };
  runtime?: {
    durable?: boolean;
    storage?: string;
    recovered_after_restart?: boolean;
  };
  comparison?: {
    baseline?: string;
    asset_enabled?: string;
    result?: string;
    status?: string;
    reason?: string;
    benchmark?: string;
    mode?: string;
    asset_ids?: string[];
    evidence_ref?: string;
  };
}

const FEEDBACK_LABELS: Record<string, string> = {
  useful: '确认有用',
  not_applicable: '当前场景不适用',
  duplicate: '内容重复',
  stale: '内容过期',
  incorrect: '内容错误',
  unobserved: '当时未观察到采用',
  accepted: '用户确认有用',
  ignored: '本轮未采用',
  used: '影响了操作',
  validated: '已被验证',
  contributed: '产生正向贡献',
  corrected: '错误或不适用',
};

function feedbackLabel(signal?: string): string {
  return signal ? FEEDBACK_LABELS[signal] ?? signal : '未标注';
}

const TASK_PROFILE_LABELS: Record<string, string> = {
  task_type: '任务类型',
  repository: '目标仓库',
  version: '项目版本',
  target_paths: '候选代码位置',
  required_capabilities: '所需团队能力',
  max_assets: '资产数量上限',
  token_budget: '上下文预算',
};

function formatProfileValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join('、');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return value === undefined || value === null || value === '' ? '未识别' : String(value);
}

function parseLines(value: string): string[] {
  return Array.from(new Set(value.split('\n').map((item) => item.trim()).filter(Boolean)));
}

function readAssetEvidence(metadataJson?: string): AssetEvidenceReceipt | null {
  if (!metadataJson) return null;
  try {
    const metadata = JSON.parse(metadataJson) as { asset_evidence?: AssetEvidenceReceipt };
    const evidence = metadata.asset_evidence;
    if (!evidence || !Array.isArray(evidence.assets)) return null;
    return evidence;
  } catch {
    return null;
  }
}

/**
 * 参与者 chip：可见文本显示 display_name（缓存未命中先回退 id），
 * title 保留语义 tooltip + user_id 供排查。
 * 抽子组件是 Rules of Hooks 要求（不能在 .map 里循环调 useUserDisplayName）。
 */
function UserChip({
  userId,
  currentUser,
  tooltip,
}: {
  userId: string;
  currentUser: string;
  tooltip: string;
}) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span className="_memory-workbench-chip" title={`${tooltip} · ${userId}`}>
      <UserIcon size={12} />
      <Text theme="text">{name || userId}</Text>
      {userId === currentUser && <span className="_memory-workbench-chip-you">{t('common.you.short')}</span>}
    </span>
  );
}

export default function TaskDetail({
  task,
  onUpdateStatus,
  onUpdateTask,
  onDelete,
  canDelete,
  agents,
  team,
  currentUser,
  participation,
}: {
  task: Task;
  onUpdateStatus: (s: Task['status']) => void;
  onUpdateTask: (patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents' | 'acceptance'>>) => void;
  /** 删除当前 task（权限校验与二次确认由外层统一处理） */
  onDelete: () => void;
  canDelete: boolean;
  agents: AgentOption[];
  /** 当前 task 所属 team — 可能为 null（理论上不会，但 team 被删除场景需兜底） */
  team: Team | null;
  currentUser: string;
  /** 从 useTeamParticipation 分桶后传下来的当前 task 观测数据 */
  participation: TaskParticipationView;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  // 编辑权限：team 内任意 member 可改 task（含切换 status）。
  const canEdit = canEditTask(task, team, currentUser);
  const assetEvidence = useMemo(() => readAssetEvidence(task.metadata_json), [task.metadata_json]);

  // —— 编辑态：只在用户点「编辑」后才进入；草稿独立维护，取消即丢弃 —— //
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description);
  const [draftSourceUrl, setDraftSourceUrl] = useState(task.source_url);
  const [draftCriteria, setDraftCriteria] = useState(task.acceptance.criteria.join('\n'));
  const [draftRequiredTests, setDraftRequiredTests] = useState(task.acceptance.required_tests.join('\n'));
  const [draftTargetPaths, setDraftTargetPaths] = useState(task.acceptance.target_paths.join('\n'));
  const [draftRequireCodeChange, setDraftRequireCodeChange] = useState<boolean | null>(task.acceptance.require_code_change);
  const navigate = useNavigate();
  const [candidateStatuses, setCandidateStatuses] = useState<Record<string, string>>({});
  const [candidateReviewing, setCandidateReviewing] = useState<string | null>(null);

  // 切换 task / 退出编辑时同步草稿（避免编辑 A 后切换到 B 草稿还停在 A）
  useEffect(() => {
    setEditing(false);
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setDraftSourceUrl(task.source_url);
    setDraftCriteria(task.acceptance.criteria.join('\n'));
    setDraftRequiredTests(task.acceptance.required_tests.join('\n'));
    setDraftTargetPaths(task.acceptance.target_paths.join('\n'));
    setDraftRequireCodeChange(task.acceptance.require_code_change);
    setCandidateStatuses({});
    setCandidateReviewing(null);
  }, [task.task_id]);

  function startEdit() {
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setDraftSourceUrl(task.source_url);
    setDraftCriteria(task.acceptance.criteria.join('\n'));
    setDraftRequiredTests((
      task.acceptance.required_tests.length > 0
        ? task.acceptance.required_tests
        : assetEvidence?.completion?.required_tests ?? []
    ).join('\n'));
    setDraftTargetPaths((
      task.acceptance.target_paths.length > 0
        ? task.acceptance.target_paths
        : assetEvidence?.completion?.target_paths ?? []
    ).join('\n'));
    setDraftRequireCodeChange(task.acceptance.require_code_change);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
  }
  function saveEdit() {
    const patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents' | 'acceptance'>> = {};
    const title = draftTitle.trim();
    if (title.length === 0) {
      tea.notify.warning(t('task.titleRequired'));
      return;
    }
    if (title !== task.title) patch.title = title;
    if (draftDesc !== task.description) patch.description = draftDesc;
    if (draftSourceUrl.trim() !== task.source_url) patch.source_url = draftSourceUrl.trim();

    const confirmedCriteria = parseLines(draftCriteria);
    const generatedSuggestions = confirmedCriteria.length === 0
      ? (task.acceptance.suggested_criteria.length > 0
          ? task.acceptance.suggested_criteria
          : suggestAcceptanceCriteria(title, draftDesc))
      : [];
    const acceptance: TaskAcceptanceContract = {
      version: '2',
      criteria: confirmedCriteria,
      suggested_criteria: generatedSuggestions,
      criteria_status: confirmedCriteria.length > 0 ? 'confirmed' : 'proposed',
      required_tests: parseLines(draftRequiredTests),
      require_code_change: draftRequireCodeChange,
      target_paths: parseLines(draftTargetPaths),
      source: confirmedCriteria.length > 0 ? 'team_task_owner_declared' : 'system_generated_candidate',
      generated_by: confirmedCriteria.length > 0 ? undefined : 'deterministic-task-analyzer/v1',
      generated_at: confirmedCriteria.length > 0 ? undefined : (task.acceptance.generated_at ?? new Date().toISOString()),
      verification_policy: 'trusted_ci',
    };
    if (JSON.stringify(acceptance) !== JSON.stringify(task.acceptance)) {
      patch.acceptance = acceptance;
    }

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    onUpdateTask(patch);
    setEditing(false);
  }

  // 参与者展示：creator 单列独立；其余进 "参与的 User"。
  // 数据源统一走 participation-log 观测 —— proxy session init 完成时 append 的
  // "实际起过 session 的 user"。creator 用自己的 agent 开工也算一次真实参与，
  // 所以不再过滤 creator（会同时出现在"创建者"和"参与的 User"两处，语义不同）。
  const participantUsers = participation.users;

  // 「实际参与 Agent」：session 观测到的 agent，映射到 team 的 agent name；
  // 未在 team agents 列表里的（比如已被删除）保留 agent_id 兜底展示。
  const sessionAgents = useMemo(() => {
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return participation.agentIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
  }, [participation.agentIds, agents]);
  const contextualSuggestedCriteria = (assetEvidence?.acceptance_plan?.criteria ?? [])
    .map((item) => item.text ?? '')
    .filter(Boolean);
  const runtimeSuggestedCriteria = contextualSuggestedCriteria.length > 0
    ? contextualSuggestedCriteria
    : assetEvidence?.acceptance_contract?.suggested_criteria ?? [];
  // 创建任务时的文字规则只负责即时预览；CodeBuddy 开始工作后，以真实团队
  // 资产和仓库上下文生成的建议为准，再交给负责人确认。
  const visibleSuggestedCriteria = runtimeSuggestedCriteria.length > 0
    ? runtimeSuggestedCriteria
    : task.acceptance.suggested_criteria;
  const acceptanceStatus = task.acceptance.criteria_status !== 'not_requested'
    ? task.acceptance.criteria_status
    : assetEvidence?.acceptance_contract?.criteria_status ?? 'not_requested';
  const hasAcceptance =
    task.acceptance.criteria.length > 0 ||
    visibleSuggestedCriteria.length > 0 ||
    task.acceptance.required_tests.length > 0 ||
    task.acceptance.target_paths.length > 0;
  const inferredTests = assetEvidence?.completion?.required_tests ?? [];
  const inferredPaths = assetEvidence?.completion?.target_paths ?? [];
  const visibleTests = task.acceptance.required_tests.length > 0
    ? task.acceptance.required_tests
    : inferredTests;
  const visiblePaths = task.acceptance.target_paths.length > 0
    ? task.acceptance.target_paths
    : inferredPaths;
  const completion = assetEvidence?.completion;
  const pendingStatusHint = task.status !== 'running' || !completion
    ? ''
    : completion.engineering_complete
      ? '独立工程验证已经通过，任务状态正在自动同步。'
      : (completion.changed_paths?.length ?? 0) > 0
        ? assetEvidence?.acceptance_contract?.verification_policy === 'trusted_ci'
          ? 'CodeBuddy 已修改代码；正在等待独立 CI/验证器确认测试结果，通过后会自动变为“已完成”。'
          : '已经观察到代码修改，但必要测试尚未全部通过。'
        : '尚未观察到目标代码修改；仅选择任务或注入资产不会自动完成任务。';

  function confirmSuggestedCriteria() {
    if (visibleSuggestedCriteria.length === 0) return;
    onUpdateTask({
      acceptance: {
        ...task.acceptance,
        version: '2',
        criteria: visibleSuggestedCriteria,
        suggested_criteria: [],
        criteria_status: 'confirmed',
        source: 'team_task_owner_confirmed_generated',
      },
    });
    tea.notify.success(t('task.acceptanceConfirmed'));
  }

  // Task 回执保存的是候选生成时的快照；审核动作发生在 Core 的资产主表。
  // 每次打开/刷新任务时以 Core 当前状态为准，避免已发布资产仍显示“待审核”。
  useEffect(() => {
    const candidates = assetEvidence?.candidates ?? [];
    if (candidates.length === 0) return;
    let cancelled = false;
    void Promise.all(
      candidates.map(async (candidate) => {
        try {
          const current = await assetsApi.get(candidate.asset_id);
          return [candidate.asset_id, current.status] as const;
        } catch {
          // 回执仍是可审计的降级来源；读取失败时保留快照状态。
          return [candidate.asset_id, candidate.status] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setCandidateStatuses(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [assetEvidence?.trace_id]);

  async function reviewCandidate(candidate: CandidateAssetReceipt, decision: 'approve' | 'reject') {
    if (decision === 'approve') { navigate(`/quality?asset_id=${encodeURIComponent(candidate.asset_id)}`); return; }
    setCandidateReviewing(candidate.asset_id);
    try {
      const updated = await assetsApi.review(
        candidate.asset_id,
        decision,
        '当前证据不足或不适合作为团队权威资产',
      );
      setCandidateStatuses((current) => ({ ...current, [candidate.asset_id]: updated.status }));
      tea.notify.success('候选资产已拒绝并归档');
    } catch (error) {
      tea.notify.error(error instanceof Error ? error.message : '候选资产审核失败');
    } finally {
      setCandidateReviewing(null);
    }
  }

  return (
    <div className="_memory-workbench-detail-content">
      {/* === 工具行：编辑 + 状态切换（标题 / task_id / team 已在抽屉头部展示） === */}
      <div className="_memory-workbench-detail-toolbar">
        {editing ? (
          <>
            <Input
              value={draftTitle}
              onChange={setDraftTitle}
              placeholder={t('task.titlePlaceholder')}
              size="full"
              className="_memory-workbench-title-input"
            />
            <Button onClick={cancelEdit}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={saveEdit}>{t('task.save')}</Button>
          </>
        ) : (
          <>
            {canEdit && (
              <Button type="text" onClick={startEdit} tooltip={t('task.edit.tooltip')}>
                <EditIcon size={14} />
                {t('task.edit')}
              </Button>
            )}
            <Segment
              value={task.status}
              onChange={(v) => onUpdateStatus(v as Task['status'])}
              disabled={!canEdit}
              options={(Object.keys(statusLabels) as Task['status'][]).map((s) => ({
                value: s,
                text: statusLabels[s],
              }))}
            />
          </>
        )}
      </div>

      {pendingStatusHint && (
        <div className="_memory-workbench-status-hint" role="status">
          <strong>为什么仍是“进行中”：</strong>
          <span>{pendingStatusHint}</span>
        </div>
      )}

      {/* === 参与者 === */}
      <div className="_memory-workbench-people">
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.creator')}</Text>
          <UserChip
            userId={task.creator_user_id}
            currentUser={currentUser}
            tooltip={t('task.creator.tooltip')}
          />
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.participantUsers')}</Text>
          {participantUsers.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            participantUsers.map((u) => (
              <UserChip
                key={u}
                userId={u}
                currentUser={currentUser}
                tooltip={t('task.participantUsers.tooltip')}
              />
            ))
          )}
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.sessionAgents')}</Text>
          {sessionAgents.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            sessionAgents.map((a) => (
              <span
                key={a.id}
                className="_memory-workbench-chip"
                title={t('task.sessionAgents.tooltip', { id: a.id })}
              >
                <UsergroupIcon size={12} />
                <Text theme="text">{a.name}</Text>
              </span>
            ))
          )}
        </div>
      </div>

      {/* === 描述 === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">{t('taskCreate.repository')}</Text>
        {editing ? (
          <Input
            value={draftSourceUrl}
            onChange={setDraftSourceUrl}
            size="full"
            placeholder={t('taskCreate.repositoryPlaceholder')}
          />
        ) : (
          <div className="_memory-workbench-desc-view">
            {task.source_url || t('task.repositoryUnbound')}
          </div>
        )}
      </div>

      {/* === 描述 === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">{t('task.description')}</Text>
        {editing ? (
          <Input.TextArea
            value={draftDesc}
            onChange={setDraftDesc}
            rows={6}
            size="full"
            placeholder={t('task.descriptionPlaceholder')}
          />
        ) : (
          <div className="_memory-workbench-desc-view">{task.description}</div>
        )}
      </div>

      {/* === 验收契约：创建者声明的完成标准 + 可自动核验条件 === */}
      <div className="_memory-workbench-block _memory-task-acceptance">
        <div className="_memory-task-acceptance-heading">
          <Text theme="label" className="_memory-workbench-block-label">{t('task.acceptance')}</Text>
          {!editing && (
            <span className={acceptanceStatus === 'confirmed' ? '_is-complete' : '_is-pending'}>
              {acceptanceStatus === 'confirmed'
                ? t('task.acceptanceConfirmedStatus')
                : acceptanceStatus === 'not_required'
                  ? t('task.acceptanceNotRequired')
                  : t('task.acceptanceProposedStatus')}
            </span>
          )}
        </div>
        {editing ? (
          <div className="_memory-task-acceptance-edit">
            <label>
              <span>{t('task.acceptanceHumanCriteria')}</span>
              <Input.TextArea
                value={draftCriteria}
                onChange={setDraftCriteria}
                rows={4}
                size="full"
                placeholder={t('taskCreate.acceptancePlaceholder')}
              />
            </label>
            <details>
              <summary>{t('taskCreate.acceptanceAdvanced')}</summary>
              <label>
                <span>{t('taskCreate.requiredTests')}</span>
                <Input.TextArea
                  value={draftRequiredTests}
                  onChange={setDraftRequiredTests}
                  rows={3}
                  size="full"
                  placeholder={t('taskCreate.requiredTestsPlaceholder')}
                />
              </label>
              <label>
                <span>{t('taskCreate.targetPaths')}</span>
                <Input.TextArea
                  value={draftTargetPaths}
                  onChange={setDraftTargetPaths}
                  rows={2}
                  size="full"
                  placeholder={t('taskCreate.targetPathsPlaceholder')}
                />
              </label>
              <label className="_memory-task-acceptance-select-row">
                <span>{t('taskCreate.requireCodeChange')}</span>
                <select
                  value={draftRequireCodeChange === null ? 'auto' : draftRequireCodeChange ? 'yes' : 'no'}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraftRequireCodeChange(value === 'auto' ? null : value === 'yes');
                  }}
                >
                  <option value="auto">{t('taskCreate.autoInfer')}</option>
                  <option value="yes">{t('taskCreate.codeChangeRequired')}</option>
                  <option value="no">{t('taskCreate.codeChangeNotRequired')}</option>
                </select>
              </label>
            </details>
          </div>
        ) : hasAcceptance ? (
          <>
            {task.acceptance.criteria.length > 0 && (
              <ol className="_memory-task-acceptance-list">
                {task.acceptance.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
              </ol>
            )}
            {task.acceptance.criteria.length === 0 && visibleSuggestedCriteria.length > 0 && (
              <div className="_memory-task-acceptance-proposed">
                <div>
                  <strong>{t('task.acceptanceCandidateTitle')}</strong>
                  <p>{t('task.acceptanceCandidateDescription')}</p>
                </div>
                {canEdit && <Button onClick={confirmSuggestedCriteria}>{t('task.acceptanceConfirm')}</Button>}
                <ol>
                  {visibleSuggestedCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
                </ol>
              </div>
            )}
            <details className="_memory-task-acceptance-machine" open={task.acceptance.criteria.length === 0}>
              <summary>{t('task.acceptanceMachineChecks')}</summary>
              <dl>
                <dt>{t('task.acceptanceTests')}</dt>
                <dd>
                  {visibleTests.length > 0
                    ? visibleTests.map((name) => <code key={name}>{name}</code>)
                    : t('task.acceptanceAutoTests')}
                </dd>
                <dt>{t('task.acceptancePaths')}</dt>
                <dd>
                  {visiblePaths.length > 0
                    ? visiblePaths.map((path) => <code key={path}>{path}</code>)
                    : t('task.acceptanceAutoPaths')}
                </dd>
                <dt>{t('task.acceptanceCodeChange')}</dt>
                <dd>
                  {task.acceptance.require_code_change === null
                    ? t('task.acceptanceAutoCodeChange')
                    : task.acceptance.require_code_change
                      ? t('common.yes')
                      : t('common.no')}
                </dd>
              </dl>
            </details>
          </>
        ) : (
          <div className="_memory-task-acceptance-empty">{t('task.acceptanceEmpty')}</div>
        )}
      </div>

      {/* === 团队资产使用证据：跟 task.metadata_json 一起持久化 === */}
      <UsageEffectReceipts teamId={task.team_id} taskId={task.task_id} />
      <LearningPanel teamId={task.team_id} taskId={task.task_id} />

      {assetEvidence && (
        <div className="_memory-workbench-block _memory-asset-evidence">
          <div className="_memory-asset-evidence-heading">
            <div>
              <Text theme="label" className="_memory-workbench-block-label">团队资产使用回执</Text>
              <div className="_memory-asset-evidence-subtitle">
                Trace {assetEvidence.trace_id} · {assetEvidence.strategy === 'minimal' ? '最小充分上下文' : assetEvidence.strategy}
                {typeof assetEvidence.token_cost === 'number' ? ` · 约 ${assetEvidence.token_cost} tokens` : ''}
              </div>
            </div>
            <span className="_memory-asset-authority">
              {assetEvidence.authority === 'live_memory_hub' ? 'Memory Hub 实时权限' : '离线证据'}
            </span>
          </div>

          {assetEvidence.dynamic_retrieval && assetEvidence.turns?.length ? (
            <section className="_memory-turn-timeline">
              <div className="_memory-turn-timeline-heading">
                <div>
                  <strong>会话内动态资产推荐</strong>
                  <small>不是只在初始化时注入：系统会在每一轮根据当前问题重新检索，并记录后续反馈。</small>
                </div>
                <span>{assetEvidence.turns.length} 轮</span>
              </div>
              {assetEvidence.turns.map((turn, turnIndex) => {
                const selected = turn.selected_assets ?? [];
                const feedback = turn.feedback ?? [];
                const ciRuns = turn.ci_runs ?? [];
                const acceptancePlan = turn.acceptance_plan;
                return (
                  <details
                    className="_memory-turn-card"
                    key={turn.turn_id}
                    open={turnIndex === assetEvidence.turns!.length - 1}
                  >
                    <summary>
                      <span className="_memory-turn-index">第 {turn.turn_seq || turnIndex + 1} 轮</span>
                      <strong>{turn.query_preview || '本轮问题已脱敏'}</strong>
                      <span>{selected.length} 项资产</span>
                    </summary>
                    <div className="_memory-turn-card-body">
                      {selected.length > 0 ? (
                        <div className="_memory-turn-assets">
                          {selected.map((asset) => {
                            const signals = feedback.filter((item) => item.asset_id === asset.asset_id);
                            return (
                              <div className="_memory-turn-asset" key={asset.asset_id}>
                                <div>
                                  <span className="_memory-asset-source">
                                    {SOURCE_LABELS[asset.source_type ?? ''] ?? asset.source_type ?? '团队资产'}
                                  </span>
                                  <strong>{asset.title ?? asset.asset_id}</strong>
                                </div>
                                <div className="_memory-turn-asset-states">
                                  {(asset.states ?? []).map((state) => (
                                    <span key={state}>{ASSET_FLOW_LABELS[state as keyof typeof ASSET_FLOW_LABELS] ?? state}</span>
                                  ))}
                                  {signals.map((item, index) => (
                                    <span
                                      className={`_signal-${item.signal ?? 'unknown'}`}
                                      title={item.reason}
                                      key={`${item.signal}-${item.source}-${index}`}
                                    >
                                      {feedbackLabel(item.signal)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="_memory-turn-empty">本轮没有达到相关性、权限和成本阈值的团队资产。</p>
                      )}
                      {(acceptancePlan?.criteria ?? []).length > 0 && (
                        <details className="_memory-contextual-acceptance" open>
                          <summary>
                            <strong>CodeBuddy 基于本轮真实上下文生成的验收建议</strong>
                            <span>候选，不能自行判定通过</span>
                          </summary>
                          {(acceptancePlan?.criteria ?? []).map((criterion) => (
                            <div className="_memory-contextual-criterion" key={criterion.criterion_id ?? criterion.text}>
                              <span>{criterion.criterion_id}</span>
                              <div>
                                <strong>{criterion.text}</strong>
                                <small>{criterion.rationale}</small>
                                {(criterion.source_titles ?? []).length > 0 && (
                                  <small>依据资产：{criterion.source_titles?.join('、')}</small>
                                )}
                                {(criterion.candidate_test_ids ?? []).length > 0
                                  ? <small>候选测试：{criterion.candidate_test_ids?.join('、')}</small>
                                  : <small className="_is-gap">尚无自动化测试覆盖，需要补充测试或人工确认</small>}
                              </div>
                            </div>
                          ))}
                          <p>最终是否完成，只接受下方独立 CI/验证器的真实结果。</p>
                        </details>
                      )}
                      {ciRuns.map((run) => {
                        const pairRole = run.regression_pair?.role;
                        const hasRegressionProof = run.regression_proof?.confirmed === true
                          || (run.regression_proof?.transitions?.length ?? 0) > 0;
                        return (
                        <div
                          className={`_memory-ci-run _status-${run.status ?? 'unknown'} ${pairRole === 'baseline' ? '_is-baseline' : ''}`}
                          key={run.run_id ?? run.evidence_ref}
                        >
                          <div className="_memory-ci-run-heading">
                            <strong>
                              独立验证 · {run.provider ?? 'CI'}
                              {pairRole === 'baseline' ? ' · 修复前基线' : pairRole === 'patched' ? ' · 修复后结果' : ''}
                            </strong>
                            <span>
                              {pairRole === 'baseline' && run.status === 'failed'
                                ? '预期失败'
                                : run.status === 'passed' ? '通过' : '失败'}
                            </span>
                          </div>
                          {pairRole === 'baseline' && (
                            <div className="_memory-regression-proof _is-baseline">
                              <strong>已记录修复前失败</strong>
                              <small>将与修复后独立验证结果组成红绿证据</small>
                            </div>
                          )}
                          {hasRegressionProof && run.regression_proof && (
                            <div className={`_memory-regression-proof ${run.regression_proof.confirmed ? '_is-confirmed' : '_is-unconfirmed'}`}>
                              <strong>
                                {run.regression_proof.confirmed
                                  ? '已证明：修复前失败 → 修复后通过'
                                  : '尚未形成“修复前失败、修复后通过”的完整证据'}
                              </strong>
                              <small>
                                基线 {run.regression_proof.baseline_status === 'failed' ? '失败' : '通过'}
                                {' → '}修复后 {run.regression_proof.patched_status === 'passed' ? '通过' : '失败'}
                              </small>
                            </div>
                          )}
                          {(run.checks ?? []).map((check) => (
                            <div className="_memory-ci-check" key={check.check_id ?? check.name}>
                              <span>{check.status === 'passed' ? '✓' : '×'}</span>
                              <div>
                                <strong>{check.name ?? check.check_id}</strong>
                                {check.test_ids?.length ? <small>测试：{check.test_ids.join('、')}</small> : null}
                              </div>
                            </div>
                          ))}
                          {(run.verification_discovery?.acceptance_coverage ?? []).length > 0 && (
                            <details className="_memory-ci-coverage">
                              <summary>验收标准 → 仓库测试覆盖映射</summary>
                              {(run.verification_discovery?.acceptance_coverage ?? []).map((coverage) => (
                                <div className={`_status-${coverage.status ?? 'coverage_gap'}`} key={coverage.criterion_id ?? coverage.text}>
                                  <span>{coverage.status === 'mapped_candidate' ? '候选映射' : '覆盖缺口'}</span>
                                  <div>
                                    <strong>{coverage.text ?? coverage.criterion_id}</strong>
                                    <small>
                                      {coverage.mapped_test_ids?.length
                                        ? `关联测试：${coverage.mapped_test_ids.join('、')}`
                                        : coverage.reason ?? '需要补充自动化测试或人工验收'}
                                    </small>
                                  </div>
                                </div>
                              ))}
                            </details>
                          )}
                          {run.evidence_ref && <small className="_memory-ci-evidence">证据摘要：{run.evidence_ref}</small>}
                        </div>
                      )})}
                    </div>
                  </details>
                );
              })}
            </section>
          ) : null}

          {assetEvidence.task_profile && Object.keys(assetEvidence.task_profile).length > 0 && (
            <details className="_memory-task-profile" open>
              <summary>系统如何理解本次任务（自动画像，可追溯）</summary>
              <dl className="_memory-asset-facts">
                {Object.entries(assetEvidence.task_profile)
                  .filter(([key]) => key in TASK_PROFILE_LABELS)
                  .map(([key, field]) => (
                    <div className="_memory-task-profile-row" key={key}>
                      <dt>{TASK_PROFILE_LABELS[key]}</dt>
                      <dd>
                        <strong>{formatProfileValue(field.value)}</strong>
                        <small>来源：{field.source ?? '自动推断'}{field.reason ? ` · ${field.reason}` : ''}</small>
                      </dd>
                    </div>
                  ))}
              </dl>
            </details>
          )}

          {assetEvidence.completion && (
            <div className={`_memory-task-completion ${(assetEvidence.completion.engineering_complete ?? assetEvidence.completion.task_completed) ? '_is-complete' : '_is-pending'}`}>
              <div className="_memory-task-completion-title">
                <strong>最新一轮的任务证据状态</strong>
                <span>
                  测试 {assetEvidence.completion.test_progress?.passed ?? 0}/{assetEvidence.completion.test_progress?.total ?? 0}
                  {' · '}标准 {assetEvidence.completion.criterion_progress?.passed ?? 0}/{assetEvidence.completion.criterion_progress?.total ?? 0}
                  {' · '}资产采用 {assetEvidence.completion.used_assets ?? 0}/{assetEvidence.completion.selected_assets ?? 0}
                  {' · '}资产验证 {assetEvidence.completion.validated_assets ?? 0}/{assetEvidence.completion.selected_assets ?? 0}
                </span>
              </div>
              <p>以下统计仅对应最新一轮；此前的采用与验证记录请展开上方各轮查看。</p>
              <div className="_memory-task-dual-status">
                <div className={(assetEvidence.completion.engineering_complete ?? assetEvidence.completion.task_completed) ? '_is-ok' : '_is-waiting'}>
                  <strong>工程结果</strong>
                  <span>{(assetEvidence.completion.engineering_complete ?? assetEvidence.completion.task_completed) ? (assetEvidence.acceptance_contract?.require_code_change === false ? '自动化检查通过，本任务无需修改代码' : '代码修改与自动化检查通过') : '等待任务所需的修改或自动化检查'}</span>
                </div>
                <div className={assetEvidence.completion.business_acceptance_complete ? '_is-ok' : '_is-waiting'}>
                  <strong>业务验收</strong>
                  <span>
                    {assetEvidence.completion.business_acceptance_complete
                      ? '已确认的业务标准均有证据'
                      : acceptanceStatus === 'proposed'
                        ? '候选标准已有测试证据，等待负责人决定是否采纳为正式标准'
                        : acceptanceStatus === 'not_required'
                          ? '负责人声明无需额外业务验收'
                          : acceptanceStatus === 'confirmed'
                            ? '标准已确认，等待对应验证证据或新的验证回执'
                            : '尚未定义或仍有标准待确认'}
                  </span>
                </div>
                <div className={
                  (assetEvidence.completion.selected_assets ?? 0) > 0
                  && assetEvidence.completion.validated_assets === assetEvidence.completion.selected_assets
                    ? '_is-ok' : '_is-waiting'
                }>
                  <strong>资产效果</strong>
                  <span>
                    {(assetEvidence.completion.selected_assets ?? 0) === 0
                      ? '本轮没有推荐团队资产'
                      : assetEvidence.completion.validated_assets === assetEvidence.completion.selected_assets
                        ? '推荐资产均已与真实代码和测试证据匹配'
                        : (assetEvidence.completion.used_assets ?? 0) > 0
                          ? '已观察到资产影响操作，仍有资产等待验证'
                          : '当前只证明已注入，尚未证明影响了操作'}
                  </span>
                </div>
              </div>
              <p className="_memory-task-status-explanation">
                看板“已完成”表示工程执行结果；业务标准是否正式确认、资产是否产生贡献，分别独立展示，不互相冒充。
              </p>
              <div className="_memory-task-completion-checks">
                <span className={assetEvidence.completion.checks?.all_selected_assets_used ? '_is-ok' : ''}>资产确实影响操作</span>
                <span className={assetEvidence.completion.checks?.all_used_assets_validated ? '_is-ok' : ''}>逐资产已验证</span>
                <span className={assetEvidence.completion.checks?.all_required_tests_passed ? '_is-ok' : ''}>任务级必需测试已通过</span>
                <span className={assetEvidence.completion.checks?.required_code_change_observed ? '_is-ok' : ''}>{assetEvidence.acceptance_contract?.require_code_change === false ? '本任务不要求修改代码' : '目标代码已修改'}</span>
                <span
                  className={
                    (assetEvidence.completion.criterion_progress?.total ?? 0) > 0 &&
                    assetEvidence.completion.checks?.all_acceptance_criteria_verified
                      ? '_is-ok'
                      : ''
                  }
                >
                  {(assetEvidence.completion.criterion_progress?.total ?? 0) > 0
                    ? '逐条业务标准已有证据'
                    : '当前回执未包含逐条业务标准'}
                </span>
              </div>
              {assetEvidence.completion.criterion_results?.length ? (
                <div className="_memory-criterion-results">
                  {assetEvidence.completion.criterion_results.map((criterion) => (
                    <div className={`_memory-criterion-result _status-${criterion.status}`} key={criterion.criterion_id}>
                      <div className="_memory-criterion-result-title">
                        <strong>{criterion.criterion_id.replace('criterion-', '标准 ')}：{criterion.text}</strong>
                        <span>
                          {criterion.status === 'passed' ? '已通过'
                            : criterion.status === 'failed' ? '失败'
                              : criterion.status === 'manual_review' ? '待人工确认'
                                : '待验证'}
                        </span>
                      </div>
                      {criterion.reason && <p>{criterion.reason}</p>}
                      {(criterion.test_ids?.length || criterion.targets?.length) ? (
                        <small>
                          {criterion.test_ids?.length ? `测试：${criterion.test_ids.join('、')}` : ''}
                          {criterion.test_ids?.length && criterion.targets?.length ? ' · ' : ''}
                          {criterion.targets?.length ? `位置：${criterion.targets.join('、')}` : ''}
                          {criterion.mapping_source === 'repository_test_discovery' ? ' · 仓库测试自动映射' : ''}
                        </small>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {(assetEvidence.completion.missing_tests?.length || assetEvidence.completion.failed_tests?.length) ? (
                <div className="_memory-task-completion-missing">
                  {assetEvidence.completion.failed_tests?.length ? `失败：${assetEvidence.completion.failed_tests.join('、')}。` : ''}
                  {assetEvidence.completion.missing_tests?.length ? `待验证：${assetEvidence.completion.missing_tests.join('、')}。` : ''}
                </div>
              ) : null}
              <small>
                判定来源：{assetEvidence.completion.contract_source ?? '任务验收契约'}
                {assetEvidence.runtime?.durable ? ` · 证据已持久化（${assetEvidence.runtime.storage ?? 'durable store'}）` : ''}
                {assetEvidence.runtime?.recovered_after_restart ? ' · 本 Trace 已通过重启恢复' : ''}
              </small>
            </div>
          )}

          <div className="_memory-asset-summary">
            {ASSET_FLOW.map((state) => (
              <span key={state}>
                <b>{assetEvidence.summary?.[state] ?? 0}</b> {ASSET_FLOW_LABELS[state]}
              </span>
            ))}
          </div>

          <div className="_memory-asset-list">
            {assetEvidence.assets.map((asset) => (
              <details key={asset.asset_id} className="_memory-asset-card" open>
                <summary>
                  <span className="_memory-asset-source">{SOURCE_LABELS[asset.source_type] ?? asset.source_type}</span>
                  <strong>{asset.title}</strong>
                  {typeof asset.score === 'number' && <span className="_memory-asset-score">相关度 {asset.score.toFixed(2)}</span>}
                </summary>
                <div className="_memory-asset-flow">
                  {ASSET_FLOW.map((state, index) => {
                    const active = asset.states.includes(state);
                    return (
                      <span key={state} className={active ? '_is-active' : ''}>
                        {ASSET_FLOW_LABELS[state]}{index < ASSET_FLOW.length - 1 ? ' →' : ''}
                      </span>
                    );
                  })}
                </div>
                <dl className="_memory-asset-facts">
                  {asset.decision && <><dt>影响决策</dt><dd>{asset.decision}</dd></>}
                  {asset.target && <><dt>作用位置</dt><dd>{asset.target}</dd></>}
                  {asset.attribution && <>
                    <dt>自动归因</dt>
                    <dd>
                      置信度 {Math.round((asset.attribution.confidence ?? 0) * 100)}%
                      {' · '}{asset.attribution.grade === 'strong' ? '强证据'
                        : asset.attribution.grade === 'moderate' ? '中等证据' : '弱证据'}
                      {asset.attribution.observed_action?.matched_paths?.length
                        ? ` · 代码：${asset.attribution.observed_action.matched_paths.join('、')}` : ''}
                      {asset.attribution.validation?.matched_tests?.length
                        ? ` · 测试：${asset.attribution.validation.matched_tests.join('、')}` : ''}
                    </dd>
                  </>}
                  {asset.validation && <><dt>验证证据</dt><dd>{asset.validation}</dd></>}
                  {asset.validation_ref && <><dt>验证引用</dt><dd>{asset.validation_ref}</dd></>}
                  {asset.contribution_ref && <><dt>贡献对照</dt><dd>{asset.contribution_ref}</dd></>}
                  {asset.source_ref && <><dt>资产来源</dt><dd>{asset.source_ref}</dd></>}
                  {asset.contributor && <><dt>贡献者</dt><dd>{asset.contributor}</dd></>}
                  {(asset.version || asset.updated_at) && <>
                    <dt>版本与更新时间</dt>
                    <dd>{asset.version ?? '未标注'}{asset.updated_at ? ` · ${new Date(asset.updated_at).toLocaleString()}` : ''}</dd>
                  </>}
                  {asset.evidence_state && <><dt>原始证据状态</dt><dd>{asset.evidence_state}</dd></>}
                  {(asset.risks?.length || asset.risk) && <><dt>风险提示</dt><dd>{asset.risks?.join('；') || asset.risk}</dd></>}
                  {asset.risk_flags && <>
                    <dt>自动风险检查</dt>
                    <dd>
                      {asset.risk_flags.expired && <span className="_memory-asset-risk-tag">已过期</span>}
                      {asset.risk_flags.conflict && <span className="_memory-asset-risk-tag">存在冲突</span>}
                      {asset.risk_flags.low_confidence && <span className="_memory-asset-risk-tag">低置信</span>}
                      {asset.risk_flags.version_incompatible && <span className="_memory-asset-risk-tag">版本不兼容</span>}
                      {!Object.values(asset.risk_flags).some(Boolean) && <span className="_memory-asset-safe-tag">未发现</span>}
                    </dd>
                  </>}
                  <dt>运行时资产</dt><dd>{asset.runtime_asset_id ?? asset.asset_id}</dd>
                </dl>
              </details>
            ))}
          </div>

          {assetEvidence.comparison && (
            <div className="_memory-asset-comparison">
              <strong>反事实归因：</strong>
              {assetEvidence.comparison.status === 'contributed'
                ? `匹配可信评测 ${assetEvidence.comparison.benchmark ?? ''}，${assetEvidence.comparison.asset_ids?.length ?? 0} 项资产已证明产生正向贡献`
                : assetEvidence.comparison.status === 'validated_without_positive_ablation'
                  ? '资产已通过关联测试，但尚未完成“有资产/无资产”对照，因此不能认定产生了正向贡献'
                  : assetEvidence.comparison.status === 'unverified'
                    ? '当前任务没有匹配的可信对照评测，暂不判定资产贡献'
                : assetEvidence.comparison.status
                  ? `当前状态：${assetEvidence.comparison.status}${assetEvidence.comparison.reason ? `（${assetEvidence.comparison.reason}）` : ''}`
                  : `${assetEvidence.comparison.baseline ?? ''} → ${assetEvidence.comparison.asset_enabled ?? ''}`}
              {assetEvidence.comparison.result ? `；${assetEvidence.comparison.result}` : ''}
            </div>
          )}

          {assetEvidence.candidates && assetEvidence.candidates.length > 0 && (
            <div className="_memory-candidate-review">
              <h4>任务经验回流 · 候选资产审核</h4>
              <p>自动生成内容默认不会进入 Coding 上下文。审核通过后才发布为团队资产；拒绝后进入归档。</p>
              {assetEvidence.candidates.map((candidate) => {
                const status = candidateStatuses[candidate.asset_id] ?? candidate.status;
                return (
                  <div className="_memory-candidate-card" key={candidate.asset_id}>
                    <div>
                      <strong>{candidate.title}</strong>
                      <div>{candidate.verification}</div>
                      <small>来源 Trace：{candidate.source_trace_id ?? assetEvidence.trace_id}</small>
                    </div>
                    <div className="_memory-candidate-actions">
                      {status === 'candidate' ? (
                        <>
                          <Button
                            type="primary"
                            disabled={candidateReviewing === candidate.asset_id}
                            onClick={() => void reviewCandidate(candidate, 'approve')}
                          >前往质量中心审核</Button>
                          <Button
                            disabled={candidateReviewing === candidate.asset_id}
                            onClick={() => void reviewCandidate(candidate, 'reject')}
                          >拒绝</Button>
                        </>
                      ) : (
                        <span className={status === 'approved' ? '_memory-asset-safe-tag' : '_memory-asset-risk-tag'}>
                          {status === 'approved' ? '已发布' : '已拒绝/归档'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <Text theme="weak" className="_memory-workbench-footer">
        {t('task.footer', { created: new Date(task.created_at_ms).toLocaleString(), updated: new Date(task.updated_at_ms).toLocaleString() })}
      </Text>

      {/* === 危险操作 === */}
      {canDelete && (
        <div className="_memory-workbench-danger">
          <Button type="error" onClick={onDelete}>
            <DeleteIcon size={12} /> {t('task.delete.okText')}
          </Button>
        </div>
      )}
    </div>
  );
}
