import { createHash } from "node:crypto";
import type { ProxyConfig } from "../../types.js";
import type { ContextBlock, ContextMessage } from "../types.js";
import { qualityEvents, observeQualityWindow } from "./quality-observer.js";
import { getMetadataClient } from "../../meta/client.js";
import { deliverQuality } from "./quality-outbox.js";
import {
  extractTeamAssetObservations,
  stableTurnEvidenceTrace,
} from "./team-assets-evidence-observer.js";

export interface AssistantToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Flush the current assistant response without waiting for another user turn. */
export async function observeTeamAssetAssistantResponse(
  config: ProxyConfig,
  input: {
    sessionId: string;
    turnSeq: number;
    actorId: string;
    text: string;
    toolCalls: AssistantToolCall[];
    qualityContext?: { spaceId: string; userKey: string; teamId: string; taskId: string };
  },
): Promise<void> {
  const settings = config.injection?.teamAssets;
  if (!config.injection?.enabled || !settings?.enabled || !input.sessionId) return;

  const blocks: ContextBlock[] = [];
  if (input.text) blocks.push({ type: "text", content: input.text });
  for (const call of input.toolCalls) {
    if (!call.id || !call.name) continue;
    blocks.push({
      type: "tool_use",
      content: JSON.stringify({ name: call.name, arguments: call.arguments }),
      metadata: { tool_id: call.id },
    });
  }
  if (blocks.length === 0) return;

  const messages: ContextMessage[] = [{ role: "assistant", blocks }];
  if (input.qualityContext?.taskId && config.coreSkill) {
    const q = input.qualityContext;
    try {
      await deliverQuality(config.coreSkill, q.spaceId, q.userKey, "window", { team: q.teamId, task: q.taskId, session: input.sessionId, events: qualityEvents(messages) });
    } catch { console.warn("[quality] response observation not acknowledged"); }
  }
  const observations = extractTeamAssetObservations(messages);
  if (
    observations.declarations.length === 0
    && observations.feedback.length === 0
    && observations.acceptance_declarations.length === 0
    && observations.codebuddy_acceptance_plan === null
    && observations.tool_calls.length === 0
  ) return;

  const traceId = stableTurnEvidenceTrace(input.sessionId, input.turnSeq);
  const body = {
    trace_id: traceId,
    actor_id: input.actorId,
    observation_boundary: "assistant_response_complete",
    ...observations,
  };
  const serialized = JSON.stringify(body);
  const endpoint = `${settings.endpoint.replace(/\/$/, "")}/v1/evidence/observe`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": createHash("sha256")
          .update(`${endpoint}\0${serialized}`)
          .digest("hex"),
        ...(settings.serviceToken
          ? { authorization: `Bearer ${settings.serviceToken}` }
          : {}),
      },
      body: serialized,
      signal: AbortSignal.timeout(Math.max(250, settings.timeoutMs)),
    });
    if (!response.ok) {
      console.warn(`[team-assets] response evidence rejected: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(
      `[team-assets] response evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
