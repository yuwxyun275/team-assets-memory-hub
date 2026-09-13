import { describe, expect, it } from "vitest";
import { renderAssetBody, renderAssetCard, renderDisclosure, hasAssetBody, visibleTexts, estimateDisclosureTokens, type PublishedAsset } from "../disclosure.js";

const asset: PublishedAsset = { asset_id: "skill-1", name: "缓存恢复测试", quality_publication: {
  revision_id: "revision-1", snapshot: { body: "模拟故障后验证缓存恢复。".repeat(80), content_version: "v1", declared_scope: "缓存恢复验证", asset_type: "skill" },
} };
const base = { assets: [asset], messages: [] as any[], bridgeBaseUrl: "http://127.0.0.1:8096", spaceId: "default", sessionId: "session", tokenBudget: 2800, inlineMaxChars: 600 };
const message = (content: string, type = "text") => ({ role: "user" as const, blocks: [{ type: type as any, content }] });

describe("asset cards and actual-context deduplication", () => {
  it("shows mandatory preflight and unverified scope on transferable workflow cards", () => {
    const workflow = structuredClone(asset);
    workflow.quality_publication.snapshot.workflow_scope = { suggested: "cross_project", requirements: ["核对当前项目约定"], verification_status: "unverified_workflow", admission: "check_preconditions_before_execution" };
    const card = renderAssetCard(workflow, base.bridgeBaseUrl, base.spaceId, base.sessionId);
    expect(card).toContain("执行前必须读取正文"); expect(card).toContain("完整流程尚未独立验证");
    const disclosure = renderDisclosure({ ...base, assets: [workflow] });
    expect(disclosure.bodies).toHaveLength(0); expect(disclosure.cards).toHaveLength(1);
  });
  it("first provides a small card with an executable versioned read, not the body", () => {
    const out = renderDisclosure(base);
    expect(out.content).toContain("/asset-bridge/read"); expect(out.content).toContain("revision-1");
    expect(out.content).not.toContain(asset.quality_publication.snapshot.body);
    // Progressive disclosure replaces the old team_assets block, so the
    // adoption protocol must survive independently of the omitted body.
    expect(out.content).toContain('<team_asset_use>');
    expect(out.content).toContain('未采用不填');
    expect(estimateDisclosureTokens(out.content)).toBeLessThanOrEqual(base.tokenBudget);
    expect(out.cards).toHaveLength(1); expect(out.bodies).toHaveLength(0);
  });
  it("does not append a second card if the entire same card remains", () => {
    const card = renderAssetCard(asset, base.bridgeBaseUrl, base.spaceId, base.sessionId);
    expect(renderDisclosure({ ...base, messages: [message(card)] }).content).toBe("");
  });
  it("restores a lost or compressed card, without restoring an unread full body", () => {
    const out = renderDisclosure({ ...base, messages: [message("摘要：曾推荐缓存恢复测试，revision-1。")] });
    expect(out.cards).toHaveLength(1); expect(out.bodies).toHaveLength(0);
  });
  it("reuses the whole body in tool stdout without adding a duplicate", () => {
    const body = renderAssetBody(asset.asset_id, "revision-1", asset.quality_publication.snapshot.body);
    const messages = [message(JSON.stringify({ stdout: body }), "tool_result")];
    const original = JSON.stringify(messages);
    const out = renderDisclosure({ ...base, messages });
    expect(out.content).toBe(""); expect(out.bodies).toHaveLength(1);
    expect(JSON.stringify(messages)).toBe(original);
  });
  it("does not mistake a surviving ID/hash or a partial body for a complete asset", () => {
    const body = renderAssetBody(asset.asset_id, "revision-1", asset.quality_publication.snapshot.body);
    expect(hasAssetBody(visibleTexts([message(body.slice(0, -80))]), asset)).toBe(false);
    const out = renderDisclosure({ ...base, messages: [message(body.slice(0, -80))] });
    expect(out.cards).toHaveLength(1); expect(out.bodies).toHaveLength(0);
  });
  it("does not reuse an old version even when its content is identical", () => {
    const old = renderAssetBody(asset.asset_id, "revision-0", asset.quality_publication.snapshot.body);
    const out = renderDisclosure({ ...base, messages: [message(old)] });
    expect(out.cards).toHaveLength(1); expect(out.bodies).toHaveLength(0);
  });
  it("recognizes CodeBuddy CRLF and a missing final wrapper bracket, without changing history", () => {
    const a = { ...asset, quality_publication: { ...asset.quality_publication, snapshot: { ...asset.quality_publication.snapshot, body: "first line\nsecond line\n" } } };
    const rendered = renderAssetBody(a.asset_id, "revision-1", a.quality_publication.snapshot.body);
    const transported = rendered.replace(/\n/g, "\r\n").slice(0, -1);
    const messages = [message(JSON.stringify({ stdout: transported }), "tool_result")];
    const original = JSON.stringify(messages);
    expect(hasAssetBody(visibleTexts(messages), a)).toBe(true);
    expect(hasAssetBody([transported.replace("</team_asset_content", "\r\n</team_asset_content")], a)).toBe(true);
    expect(hasAssetBody([transported.replace("second line", "second lin")], a)).toBe(false);
    expect(hasAssetBody([transported.replace("first line", "first  line")], a)).toBe(false);
    expect(hasAssetBody([transported + "_wrong"], a)).toBe(false);
    expect(JSON.stringify(messages)).toBe(original);
  });
  it("eagerly includes a short Wiki constraint, within budget", () => {
    const wiki = { ...asset, quality_publication: { ...asset.quality_publication, snapshot: { ...asset.quality_publication.snapshot, asset_type: "llm_wiki", body: "查询必须保留租户过滤。" } } };
    expect(renderDisclosure({ ...base, assets: [wiki] }).bodies).toHaveLength(1);
    const out = renderDisclosure({ ...base, tokenBudget: 1 });
    expect(out.content).toBe(""); expect(out.omitted).toEqual([asset.asset_id]);
    expect(estimateDisclosureTokens(renderDisclosure(base).content)).toBeLessThanOrEqual(base.tokenBudget);
  });
  it("quotes shell arguments instead of interpolating asset names or IDs as commands", () => {
    const value = { ...asset, asset_id: "asset'$(touch /tmp/unsafe)" };
    expect(renderAssetCard(value, base.bridgeBaseUrl, base.spaceId, base.sessionId)).toContain(`'"'"'`);
  });
});
