import type { QualityModelConfig } from "./configured-reviewer.js";
/** Provider-specific output contract; never changes the user's normal CodeBuddy model configuration. */
export function reviewerTransport(config: QualityModelConfig, transport: typeof fetch = fetch): typeof fetch {
  if (new URL(config.baseUrl).hostname !== "api.deepseek.com") return transport;
  return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof init?.body !== "string") return transport(url, init);
    const body = JSON.parse(init.body);
    // Official DeepSeek JSON mode + non-thinking review avoids exhausting a bounded output budget on hidden reasoning.
    return transport(url, { ...init, body: JSON.stringify({ ...body, response_format: { type: "json_object" }, thinking: { type: "disabled" } }) });
  }) as typeof fetch;
}
