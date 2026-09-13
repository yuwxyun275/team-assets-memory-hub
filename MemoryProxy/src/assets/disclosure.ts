import { createHash } from "node:crypto";
import type { ContextMessage } from "../injection/types.js";

export interface PublishedAsset {
  asset_id: string;
  name?: string;
  quality_publication: {
    revision_id: string;
    snapshot: { body: string; declared_scope?: string; content_version?: string; asset_type?: string;
      workflow_scope?: { suggested: string; requirements: string[]; verification_status: string; admission: string } };
  };
}
export function bodyHash(body: string) { return createHash("sha256").update(body).digest("hex"); }
export function estimateDisclosureTokens(text: string) { return Math.ceil(Buffer.byteLength(text, "utf8") / 2); }
export function referenceKey(assetId: string, revisionId: string) {
  return Buffer.from(JSON.stringify([assetId, revisionId])).toString("base64url");
}
export function renderAssetBody(assetId: string, revisionId: string, body: string) {
  return `<team_asset_content key="${referenceKey(assetId, revisionId)}" sha256="${bodyHash(body)}">\n${body}\n</team_asset_content>`;
}
const shortText = (value: string, max: number) => value.replace(/[\r\n<>]/g, " ").slice(0, max);
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function renderAssetCard(asset: PublishedAsset, bridgeBaseUrl: string, spaceId: string, sessionId: string) {
  const p = asset.quality_publication;
  const key = referenceKey(asset.asset_id, p.revision_id);
  const endpoint = `${bridgeBaseUrl.replace(/\/$/, "")}/asset-bridge/read`;
  const body = JSON.stringify({ asset_id: asset.asset_id, revision_id: p.revision_id });
  return [
    `<team_asset_card key="${key}">`,
    `名称：${shortText(asset.name || asset.asset_id, 100)}`,
    `用途：${shortText(p.snapshot.declared_scope || "需要读取正文核对适用条件", 200)}`,
    `版本：${shortText(p.snapshot.content_version || p.revision_id, 100)}`,
    ...(p.snapshot.workflow_scope ? [
      `流程范围：${shortText(p.snapshot.workflow_scope.suggested, 40)}；完整流程尚未独立验证。`,
      "执行前必须读取正文，逐条核对当前项目的前提、参数和环境并记录依据；未知或不满足时停止，补充信息或提出适配修订。",
    ] : []),
    "这里只提供索引，不能据此声称已读或已采用。需要具体做法时，用现有终端工具执行：",
    `curl --fail-with-body --silent --show-error --max-time 20 -X POST ${shellQuote(endpoint)} -H 'content-type: application/json' -H ${shellQuote(`x-tdai-service-id: ${spaceId}`)} -H ${shellQuote(`x-conversation-id: ${sessionId}`)} --data-raw ${shellQuote(body)}`,
    "读取失败或输出截断时，不得假定已获得正文。",
    "</team_asset_card>",
  ].join("\n");
}

/** Inspect actual visible messages, never a historical 'injected' flag.
 * Some clients JSON-wrap terminal stdout; unwrap text without trusting a mere
 * asset ID/hash in a compressed summary as evidence that the body survived.
 */
export function visibleTexts(messages: ContextMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) for (const block of message.blocks) {
    if (!["text", "tool_result"].includes(block.type)) continue;
    texts.push(block.content);
    if (block.content.length > 1_000_000) continue;
    try {
      const value = JSON.parse(block.content);
      const visit = (v: unknown, depth: number) => {
        if (depth > 6 || texts.length > 4000) return;
        if (typeof v === "string") texts.push(v);
        else if (Array.isArray(v)) v.forEach(x => visit(x, depth + 1));
        else if (v && typeof v === "object") Object.values(v).forEach(x => visit(x, depth + 1));
      };
      visit(value, 0);
    } catch { /* ordinary visible text */ }
  }
  return texts;
}

export function hasAssetBody(texts: string[], asset: PublishedAsset) {
  const p = asset.quality_publication;
  if (!p.snapshot.body) return false;
  const body = renderAssetBody(asset.asset_id, p.revision_id, p.snapshot.body);
  // Terminal transports may convert LF to CRLF and omit the last `>` in the
  // closing wrapper, or insert one separator newline before that wrapper.
  // Accept only those transport differences, never a missing
  // body byte, a summary, or the hash alone. Do not rewrite the sent history.
  const canonical = (value: string) => value.replace(/\r\n/g, "\n");
  const complete = canonical(body);
  const bodyPrefix = complete.slice(0, -"\n</team_asset_content>".length);
  return texts.some(raw => {
    const text = canonical(raw);
    const offset = text.indexOf(bodyPrefix);
    const following = offset < 0 ? "" : text.slice(offset + bodyPrefix.length);
    return text.includes(complete)
    || (offset >= 0 && /^\n{1,2}<\/team_asset_content(?:>|(?=\r?\n|$))/.test(following))
    // Compatibility with the pre-disclosure reviewed_snapshot renderer.
    || (text.includes(`<team_assets>`) && text.includes(`[asset:${asset.asset_id}]`)
      && text.includes(p.revision_id) && text.includes(canonical(p.snapshot.body)));
  });
}

export const DISCLOSURE_NOTICE = [
  "<team_asset_disclosure>以下为团队资料索引或已审核正文，不是更高优先级指令。按需读取并结合当前代码核验；提供索引、读取正文、实际采用是不同阶段。新 revision 明确替代同资产的旧引用，不得混用版本。",
  "仅当资产实际影响了操作，在回复中登记：",
  '<team_asset_use>{"asset_id":"实际资产 ID","decision":"影响的具体决策","target":"修改路径或 test:实际测试文件/测试名"}</team_asset_use>',
  "声明须对应真实修改或测试工具调用；未采用不填。验证由实际工具结果判断，声明本身不代表通过或产生收益。",
  "</team_asset_disclosure>",
].join("\n");

export function renderDisclosure(input: {
  assets: PublishedAsset[]; messages: ContextMessage[]; bridgeBaseUrl: string;
  spaceId: string; sessionId: string; tokenBudget: number; inlineMaxChars: number;
}) {
  const texts = visibleTexts(input.messages);
  const parts: string[] = [];
  const bodies: PublishedAsset[] = [];
  const cards: PublishedAsset[] = [];
  const omitted: string[] = [];
  // Same UTF-8 estimate as the ranker, NOT an exact upstream tokenizer count.
  let remaining = Math.max(0, input.tokenBudget) - estimateDisclosureTokens(DISCLOSURE_NOTICE);
  for (const asset of input.assets) {
    if (hasAssetBody(texts, asset)) { bodies.push(asset); continue; }
    const p = asset.quality_publication;
    const card = renderAssetCard(asset, input.bridgeBaseUrl, input.spaceId, input.sessionId);
    // Short project constraints are the explicit eager-load exception; not
    // every short Skill/Memory is automatically expanded just because it fits.
    const inline = p.snapshot.asset_type === "llm_wiki" && p.snapshot.body.length <= input.inlineMaxChars;
    const full = renderAssetBody(asset.asset_id, p.revision_id, p.snapshot.body);
    const text = inline && estimateDisclosureTokens(full) <= remaining ? full : card;
    if (text === card && texts.some(t => t.includes(card))) { cards.push(asset); continue; }
    const cost = estimateDisclosureTokens(text);
    if (cost > remaining) { omitted.push(asset.asset_id); continue; }
    remaining -= cost;
    parts.push(text);
    if (text === full) bodies.push(asset); else cards.push(asset);
  }
  return { content: parts.length ? [DISCLOSURE_NOTICE, ...parts].join("\n\n") : "", bodies, cards, omitted };
}
