import { z } from "zod";
import { sha256 } from "./evaluator.js";
import { QualityError, type Publication, type QualityLifecycle } from "./lifecycle.js";
import { sceneSchema, type RecommendationScene } from "./scene.js";
import { containsCredential } from "./rules.js";

const id = z.string().min(1).max(200);
export const disclosureScopeSchema = z.object({
  agent_id: id, session_id: id, task_id: z.string().max(200).default(""),
});
const referenceSchema = z.object({ asset_id: id, revision_id: id }).strict();
export const disclosureRememberSchema = disclosureScopeSchema.extend({
  references: z.array(referenceSchema).max(32),
  before: sceneSchema.optional(),
}).strict();
export const disclosureReadSchema = disclosureScopeSchema.extend({
  ...referenceSchema.shape, request_id: id,
  max_chars: z.number().int().min(1).max(60_000).default(60_000),
}).strict();
type Scope = z.infer<typeof disclosureScopeSchema>;
type Reference = z.infer<typeof referenceSchema> & { seen_at: number; before?: RecommendationScene };
const RETENTION_MS = 30 * 86400_000;

/** Durable catalogue, NOT proof that the model still sees the text.
 * Every read rechecks authorization and publication. Old pointers never resolve
 * silently to latest; body is read only from the immutable approved snapshot.
 */
export class AssetDisclosure {
  constructor(
    private readonly quality: QualityLifecycle,
    private readonly authorizedPublication: (assetId: string) => Promise<Publication | null>,
  ) {}

  private key(team: string, actor: string, scope: Scope) {
    return `disclosure:${sha256(JSON.stringify([team, actor, scope.agent_id, scope.task_id, scope.session_id]))}`;
  }

  async list(team: string, actor: string, input: unknown) {
    const scope = disclosureScopeSchema.strict().parse(input);
    const record = await this.quality.records.get(this.key(team, actor, scope));
    if (!record || record.team !== team || record.data.expires <= Date.now()) return { references: [] as Reference[] };
    const references: Reference[] = [];
    for (const ref of record.data.references as Reference[]) {
      if (ref.seen_at + RETENTION_MS <= Date.now()) continue;
      const publication = await this.authorizedPublication(ref.asset_id);
      if (publication?.revision_id === ref.revision_id) references.push(ref);
    }
    return { references };
  }

  async remember(team: string, actor: string, input: unknown) {
    const data = disclosureRememberSchema.parse(input);
    if (containsCredential(JSON.stringify(data))) throw new QualityError("invalid_quality_snapshot", "场景包含凭据，未保存");
    const accepted: Reference[] = [];
    for (const ref of data.references) {
      const publication = await this.authorizedPublication(ref.asset_id);
      if (publication?.revision_id === ref.revision_id) accepted.push({ ...ref, seen_at: Date.now(), ...(data.before ? { before: data.before } : {}) });
    }
    const key = this.key(team, actor, data);
    for (let attempt = 0; attempt < 4; attempt++) {
      const old = await this.quality.records.get(key);
      const merged = new Map<string, Reference>();
      if (old?.team === team && old.data.expires > Date.now()) {
        for (const ref of old.data.references as Reference[]) {
          if (ref.seen_at + RETENTION_MS > Date.now()) merged.set(`${ref.asset_id}:${ref.revision_id}`, ref);
        }
      }
      for (const ref of accepted) {
        const key = `${ref.asset_id}:${ref.revision_id}`;
        // Recommending a visible card on another tool request cannot replace its
        // original pre-recommendation scene with evidence produced afterwards.
        const original = merged.get(key);
        merged.set(key, { ...ref, ...(original?.before ? { before: original.before } : {}) });
      }
      const references = [...merged.values()].sort((a, b) => b.seen_at - a.seen_at).slice(0, 64);
      const record = { key, kind: "disclosure", team, rev: old?.rev ?? 0, updated: Date.now(), data: {
        actor, agent_id: data.agent_id, session_id: data.session_id, task_id: data.task_id,
        references, expires: Date.now() + RETENTION_MS,
      } };
      if (await this.quality.records.cas(record, record.rev)) return { references: accepted.map(r => merged.get(`${r.asset_id}:${r.revision_id}`)!) };
    }
    throw new QualityError("quality_version_conflict", "资产清单正在更新，请重试");
  }

  async read(team: string, actor: string, input: unknown) {
    const data = disclosureReadSchema.parse(input);
    const record = await this.quality.records.get(this.key(team, actor, data));
    if (!record || record.team !== team || record.data.expires <= Date.now()
        || !record.data.references.some((r: Reference) => r.asset_id === data.asset_id && r.revision_id === data.revision_id
          && r.seen_at + RETENTION_MS > Date.now())) {
      throw new QualityError("permission_denied", "该版本不在当前用户、Agent 和任务的会话资产清单中");
    }
    const publication = await this.authorizedPublication(data.asset_id);
    if (!publication || publication.revision_id !== data.revision_id) {
      throw new QualityError("quality_gate_blocked", "该版本已失效或不可访问，请重新获取推荐；未替换为其他版本");
    }
    const body = publication.snapshot.body;
    if (body.length > data.max_chars) {
      throw new QualityError("quality_content_budget_exceeded", "完整正文超过本次读取预算；未返回截断内容，请调整预算或发布更小的内容单元");
    }
    // A fetch is NOT exposure/adoption. The Proxy must observe the complete
    // returned body in a later upstream request before recording exposure.
    const key = `disclosure-read:${sha256(JSON.stringify([this.key(team, actor, data), data.asset_id, data.revision_id, data.request_id]))}`;
    const old = await this.quality.records.get(key);
    if (!old) await this.quality.records.cas({ key, team, kind: "disclosure-read", rev: 0, updated: Date.now(), data: {
      actor, ...data, fetched_at: Date.now(), expires: Date.now() + RETENTION_MS,
    } }, 0);
    return { asset_id: data.asset_id, revision_id: data.revision_id,
      content_version: publication.snapshot.content_version, body_sha256: sha256(body), body,
      complete: true as const, status: "fetched_not_yet_observed" };
  }
}
