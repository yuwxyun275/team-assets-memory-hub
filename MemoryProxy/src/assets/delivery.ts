import type { AgentContext, ContextMessage } from "../injection/types.js";

/** Text actually in the final model input, excluding tools, headers and metadata. */
export function modelInputTexts(body: Record<string, unknown>): string[] {
  const texts: string[] = [];
  const read = (v: any) => {
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach(read);
    else if (v && typeof v === "object") {
      if (typeof v.text === "string") texts.push(v.text);
      if (v.content !== undefined) read(v.content);
      if (v.type === "function_call_output") read(v.output);
    }
  };
  read(body.system); read(body.instructions); read(body.messages); read(body.input);
  return texts;
}

/** Request-local staging. No acknowledgement on prepare, exception, or HTTP error.
 * HTTP 2xx means the upstream accepted input, not that the model used an asset.
 * A lost acknowledgement is conservative (no inferred credit), never fabricated.
 */
export class AssetDelivery {
  turnSeq?: number;
  private callbacks: ((texts: string[]) => Promise<void>)[] = [];
  private settled = false;
  defer(work: (texts: string[]) => Promise<void>) { if (!this.settled) this.callbacks.push(work); }
  discard() { this.settled = true; this.callbacks = []; }
  async accept(body: Record<string, unknown>, status: number) {
    if (this.settled) return;
    this.settled = true;
    const callbacks = this.callbacks; this.callbacks = [];
    if (status < 200 || status >= 300) return;
    const texts = modelInputTexts(body);
    for (const work of callbacks) {
      try { await work(texts); }
      catch { console.warn('[asset-delivery] accepted input acknowledgement failed; no success credit inferred'); }
    }
  }
}

export function deliveredContext(ctx: AgentContext, texts: string[]): AgentContext {
  return { ...ctx, messages: [{ role: "user", blocks: texts.map(content => ({type: "text", content})) }] as ContextMessage[] };
}
