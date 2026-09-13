import { metaPost } from './base';

export const USAGE_OUTCOMES: Record<string, string> = { helpful: '有帮助', harmful: '带来问题', not_applicable: '当前环境不适用', content_error: '内容存在错误', unobserved: '证据不足' };
export const USAGE_STATES: Record<string, string> = { queued: '等待评估／重试', running: '评估中', observing: '等待后续证据', needs_recheck: '证据规则已升级，等待复评', manual_review: '自动评估失败，待人工处理', needs_evidence: '评估完成，证据不足', assessed: '评估完成', human_reviewed: '已人工评阅' };
export const APPLICABILITY_LABELS: Record<string, string> = { applicable: '当时适用', adapt: '需要适配', not_applicable: '当时不适用', unknown: '条件证据不足' };
export interface UsageEffect {
  receipt_id: string; asset_id: string; asset_name?: string; revision_id: string; task_id: string; session_id: string;
  status: string; attempts: number; total_attempts: number; can_retry: boolean; last_error: string | null;
  updated_at: number; expires_at: number; error_details?: { issues: string[] } | null;
  assessment: { outcome: string; reason: string; source: string; asset_quote?: string; evidence_contract?: string } | null;
  recommendation_scene?: { query: string; task: string; request_id: string; turn: number; hash: string; truncated: boolean;
    events: { id: string; role: string; content: string }[] } | null;
  applicability?: { verdict: string; reason: string; asset_quote?: string; citations: { event_id: string; quote: string }[] } | null;
  scene_feedback?: { score: number | null; samples: number; applicability_adjustment: number;
    scene_learning: { fit_tasks: number; matched_tasks: number; minimum_fit_tasks: number; similarity_threshold: number } | null } | null;
  observation_window?: { closed: boolean; reason: string | null; events: number; omitted_events: number };
  citations: { event_id: string; quote: string; role?: string; tool_call_id?: string }[];
}
export interface UsageEffectsReceipt { items: UsageEffect[]; summary: { assets: number; observations: number; assessed: number; helpful: number; manual_review: number }; }
export const taskUsageReceipt = (teamId: string, taskId: string) => metaPost<UsageEffectsReceipt>('asset/quality/task-receipt', { team_id: teamId, task_id: taskId });
