import { measuredModelText } from "./model-usage.js";
import { createModelReviewer } from "./model-reviewer.js";
import { reviewerTransport } from "./reviewer-transport.js";

export interface QualityModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  stream?: boolean;
}

/**
 * Reuses the project's AI SDK and gateway model configuration, but deliberately
 * does not load the tool-enabled runner or its optional reporting backends.
 * Configuration is server-owned; never taken from the evaluation request body.
 */
export function createConfiguredReviewer(config: QualityModelConfig, transport?: typeof fetch) {
  return createModelReviewer(`openai-compatible:${config.model}`, async () => {
    if (!config.baseUrl || !config.model) throw new Error("quality_reviewer_not_configured");
    const [{ createOpenAI }, { generateText, streamText }] = await Promise.all([import("@ai-sdk/openai"), import("ai")]);
    const provider = createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, fetch: reviewerTransport(config, transport) });
    return {
      async run(params) {
        const request = {
          model: provider.chat(config.model), system: params.systemPrompt, prompt: params.prompt,
          maxOutputTokens: params.maxTokens,
          maxRetries: 0,
          abortSignal: AbortSignal.any([params.abortSignal, AbortSignal.timeout(params.timeoutMs)]),
          experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
          // No tools attached, even if the model requests one in its output.
        };
        return measuredModelText(config.model, async () => {
          if (!config.stream) return generateText(request);
          const result = streamText(request);
          return { text: await result.text, usage: await result.totalUsage, response: await result.response };
        });
      },
    };
  });
}
