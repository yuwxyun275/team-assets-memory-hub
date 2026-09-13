import { describe, expect, it, vi } from "vitest";
import { createConfiguredReviewer } from "../configured-reviewer.js";
import { evaluateQuality } from "../evaluator.js";
import { criteriaFor } from "../rubrics.js";
import { snapshot } from "./fixtures.js";
import { reviewerTransport } from "../reviewer-transport.js";
import { createUsageReviewer } from "../usage-reviewer.js";

const config = { baseUrl: "https://example.invalid/v1", apiKey: "fake-key-for-transport-test", model: "test-model" };

describe("real SDK adapter with a fake HTTP transport (no network)", () => {
  it("sends original events and targeted correction to the usage evaluator, with no implicit SDK retry", async () => {
    const correction = { errors: ['citations.0.quote 不在原文中'], previous_response: '{"outcome":"helpful"}' };
    const transport = vi.fn(async (_url: unknown, init: any) => {
      const request = JSON.parse(init.body);
      expect(request.tools).toBeUndefined();
      expect(request.messages[0].content).toContain('不是事实或新证据');
      expect(JSON.parse(request.messages[1].content).correction).toEqual(correction);
      return new Response(JSON.stringify({ id: 'test', object: 'chat.completion', created: 1, model: config.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"outcome":"unobserved","reason":"缺少证据","citations":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const output = await createUsageReviewer(config, transport).review({ asset: 'asset', events: [], correction }, new AbortController().signal);
    expect(JSON.parse(String(output)).outcome).toBe('unobserved'); expect(transport).toHaveBeenCalledOnce();
  });
  it("uses the bounded DeepSeek JSON review contract without modifying normal generation", async () => {
    const fetcher=vi.fn(async()=>new Response('{}')) as unknown as typeof fetch;
    const transport=reviewerTransport({...config,baseUrl:'https://api.deepseek.com/v1'},fetcher);
    await transport('https://api.deepseek.com/v1/chat/completions',{body:JSON.stringify({model:'deepseek-v4-flash',messages:[]})});
    const body=JSON.parse((fetcher as any).mock.calls[0][1].body);
    expect(body.thinking).toEqual({type:'disabled'});expect(body.response_format).toEqual({type:'json_object'});
    expect(reviewerTransport(config,fetcher)).toBe(fetcher);
  });
  it("sends the actual body and returns grounded review through the SDK", async () => {
    const s = snapshot();
    const result = { checks: criteriaFor(s.asset_type).map((c) => ({
      id: c.id, status: "pass", reason: "测试传输响应，不代表真实模型能力",
      evidence: [{ source_id: "asset", quote: s.body }, ...(c.supportKinds ? [{ source_id: s.sources[0].id, quote: s.sources[0].content }] : [])],
    })) };
    const transport = vi.fn(async (_url: unknown, init: any) => {
      const request = JSON.parse(init.body);
      expect(request.model).toBe(config.model);
      expect(request.tools).toBeUndefined();
      expect(JSON.parse(request.messages[1].content).evidence_catalog.filter((e: any) => e.source_id === 'asset').map((e: any) => e.text).join('')).toBe(s.body);
      return new Response(JSON.stringify({
        id: "test", object: "chat.completion", created: 1, model: "test-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await evaluateQuality(s, { reviewer: createConfiguredReviewer(config, transport) });
    expect(r.decision).toBe("pass");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not retry provider errors or leak error payloads", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ error: { message: "sensitive-payload" } }), { status: 500, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const r = await evaluateQuality(snapshot(), { reviewer: createConfiguredReviewer(config, transport) });
    expect(r.reviewer.status).toBe("unavailable");
    expect(r.decision).toBe("needs_evidence");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain("sensitive-payload");
  });

  it("supports the gateway's stream-only upstream setting", async () => {
    const transport = vi.fn(async () => new Response(
      'data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"checks\\":[]}"},"finish_reason":null}]}\n\n' +
      'data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof fetch;
    const r = await evaluateQuality(snapshot(), { reviewer: createConfiguredReviewer({ ...config, stream: true }, transport) });
    expect(r.reviewer.status).toBe("invalid_response"); // Stream parsed, but empty checks cannot pass.
    expect(transport).toHaveBeenCalledTimes(2); // One bounded reference-contract repair, then fail closed.
  });
});
