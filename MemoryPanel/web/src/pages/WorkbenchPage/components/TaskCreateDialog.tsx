/**
 * TaskCreateDialog — 「新建 Task」弹窗。
 *
 * 必填字段（前端校验）：
 *   - title         任务标题
 *   - description   任务描述
 *
 * 验收标准是可选项：留空时保存系统生成的“候选标准”，不会把模型/规则建议
 * 冒充为已经由业务负责人确认的 Definition of Done。
 *
 * 关于 team 归属：
 *   不再让用户在 dialog 里选 team。team 由右上角全局 TeamSwitcher 决定，
 *   这里只 readonly 展示「将创建到 team：name (team_id)」，避免出现「右上角是 A
 *   但弹窗里默认选了 B、用户没注意一切就走偏」的两套上下文不一致问题。
 *
 * 不再在创建时选 Agent — 关联 Agent 放到 task 创建之后再做。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Tag, Input, Button, Form, Modal } from 'tea-component';
import type { TaskAcceptanceContract } from '@/services';
import { suggestAcceptanceCriteria } from '@/lib/acceptance-suggestions';
import '../styles/task-create-dialog.css';

export type TaskSourceType = 'manual' | 'tapd';

export interface TaskDraft {
  team_id: string;
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
  acceptance: TaskAcceptanceContract;
}

function lines(value: string): string[] {
  return Array.from(new Set(value.split('\n').map((item) => item.trim()).filter(Boolean)));
}

export default function TaskCreateDialog(props: {
  team: { team_id: string; name: string };
  onClose: () => void;
  onCreate: (draft: TaskDraft) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repository, setRepository] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [requiredTests, setRequiredTests] = useState('');
  const [targetPaths, setTargetPaths] = useState('');
  const [requireCodeChange, setRequireCodeChange] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestedCriteria = useMemo(
    () => suggestAcceptanceCriteria(title, description),
    [title, description],
  );
  const canSubmit = title.trim().length > 0 && description.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const confirmedCriteria = lines(acceptanceCriteria);
      await props.onCreate({
        team_id: props.team.team_id,
        title: title.trim(),
        description: description.trim(),
        source_type: 'manual',
        source_url: repository.trim(),
        linked_agents: [],
        acceptance: {
          version: '2',
          criteria: confirmedCriteria,
          suggested_criteria: confirmedCriteria.length > 0 ? [] : suggestedCriteria,
          criteria_status: confirmedCriteria.length > 0 ? 'confirmed' : 'proposed',
          required_tests: lines(requiredTests),
          require_code_change: requireCodeChange,
          target_paths: lines(targetPaths),
          source: confirmedCriteria.length > 0 ? 'team_task_owner_declared' : 'system_generated_candidate',
          generated_by: confirmedCriteria.length > 0 ? undefined : 'deterministic-task-analyzer/v1',
          generated_at: confirmedCriteria.length > 0 ? undefined : new Date().toISOString(),
          verification_policy: 'trusted_ci',
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={t('taskCreate.caption')} size="l" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label={t('taskCreate.team')}>
            <div className="_memory-tcd-team-row">
              <span className="_memory-tcd-team-avatar">{props.team.name.slice(0, 1).toUpperCase()}</span>
              <div className="_memory-tcd-team-meta">
                <div className="_memory-tcd-team-label">{t('taskCreate.teamLabel')}</div>
                <div className="_memory-tcd-team-name-row">
                  <span className="_memory-tcd-team-name">{props.team.name}</span>
                  <Tag size="sm">{props.team.team_id}</Tag>
                </div>
              </div>
            </div>
          </Form.Item>
          <Form.Item label={t('taskCreate.title')} required>
            <Input
              autoFocus
              size="full"
              value={title}
              onChange={setTitle}
              placeholder={t('taskCreate.titlePlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('taskCreate.description')} required extra={t('taskCreate.descriptionExtra')}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={4}
              placeholder={t('taskCreate.descriptionPlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('taskCreate.repository')} extra={t('taskCreate.repositoryExtra')}>
            <Input
              size="full"
              value={repository}
              onChange={setRepository}
              placeholder={t('taskCreate.repositoryPlaceholder')}
            />
          </Form.Item>
          <Form.Item
            label={t('taskCreate.acceptance')}
            extra={t('taskCreate.acceptanceExtra')}
          >
            <Input.TextArea
              size="full"
              value={acceptanceCriteria}
              onChange={setAcceptanceCriteria}
              rows={4}
              placeholder={t('taskCreate.acceptancePlaceholder')}
            />
            {lines(acceptanceCriteria).length === 0 && suggestedCriteria.length > 0 && (
              <div className="_memory-tcd-candidate-box">
                <div className="_memory-tcd-candidate-heading">
                  <strong>{t('taskCreate.acceptanceCandidates')}</strong>
                  <Button type="link" onClick={() => setAcceptanceCriteria(suggestedCriteria.join('\n'))}>
                    {t('taskCreate.acceptanceAdopt')}
                  </Button>
                </div>
                <ol>{suggestedCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ol>
                <p>{t('taskCreate.acceptanceCandidateHint')}</p>
              </div>
            )}
          </Form.Item>
          <Form.Item label={t('taskCreate.acceptanceSettings')}>
            <div className="_memory-tcd-recommendation-panel">
              <div className="_memory-tcd-recommendation-title">
                <strong>{t('taskCreate.acceptanceAdvanced')}</strong>
                <span>{t('taskCreate.autoInfer')}</span>
              </div>
              <Alert type="info">{t('taskCreate.acceptanceAutoHint')}</Alert>
              <details className="_memory-tcd-advanced">
                <summary>{t('taskCreate.acceptanceOverride')}</summary>
                <div className="_memory-tcd-advanced-body">
                  <div className="_memory-tcd-field">
                    <label>{t('taskCreate.requiredTests')}</label>
                    <Input.TextArea
                      size="full"
                      value={requiredTests}
                      onChange={setRequiredTests}
                      rows={3}
                      placeholder={t('taskCreate.requiredTestsPlaceholder')}
                    />
                    <p>{t('taskCreate.requiredTestsExtra')}</p>
                  </div>
                  <div className="_memory-tcd-field">
                    <label>{t('taskCreate.targetPaths')}</label>
                    <Input.TextArea
                      size="full"
                      value={targetPaths}
                      onChange={setTargetPaths}
                      rows={2}
                      placeholder={t('taskCreate.targetPathsPlaceholder')}
                    />
                    <p>{t('taskCreate.targetPathsExtra')}</p>
                  </div>
                  <label className="_memory-tcd-select-row">
                    <span>{t('taskCreate.requireCodeChange')}</span>
                    <select
                      value={requireCodeChange === null ? 'auto' : requireCodeChange ? 'yes' : 'no'}
                      onChange={(event) => {
                        const value = event.target.value;
                        setRequireCodeChange(value === 'auto' ? null : value === 'yes');
                      }}
                    >
                      <option value="auto">{t('taskCreate.autoInfer')}</option>
                      <option value="yes">{t('taskCreate.codeChangeRequired')}</option>
                      <option value="no">{t('taskCreate.codeChangeNotRequired')}</option>
                    </select>
                  </label>
                </div>
              </details>
            </div>
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!canSubmit} loading={submitting}>{t('taskCreate.submit')}</Button>
        <Button onClick={props.onClose} disabled={submitting}>{t('taskCreate.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
