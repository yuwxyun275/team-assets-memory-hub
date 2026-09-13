/** Client transport envelopes are data, never instructions or usage evidence. */
export function codebuddySummary(raw: string): { summary: string; current: string } | undefined {
  const match = raw.match(/^\s*(?:<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>\s*)?<cb_summary>([\s\S]*?)<\/cb_summary>([\s\S]*)$/);
  if (!match) return;
  // Only the documented standalone envelope, not an inline quotation.
  if (!/^\s*Summary of the conversation so far:/.test(match[1])) return;
  return { summary: match[1], current: match[2] };
}
