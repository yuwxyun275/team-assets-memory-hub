/**
 * Evidence declarations are a proxy/model control protocol, not user content.
 * Keep the raw text long enough for the evidence observer to consume it, then
 * remove the declarations from the response rendered by coding clients.
 */
const CONTROL_TAGS = [
  "team_asset_use",
  "team_asset_feedback",
  "acceptance_evidence",
  "acceptance_plan",
] as const;

const OPEN_TAGS = CONTROL_TAGS.map((tag) => `<${tag}>`);

export function stripTeamAssetControlMarkup(text: string): string {
  let result = text;
  for (const tag of CONTROL_TAGS) {
    result = result.replace(
      new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "g"),
      "",
    );
  }
  return result.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** Stateful version used for OpenAI SSE deltas, where a tag may span chunks. */
export class TeamAssetControlMarkupFilter {
  private pending = "";
  private hiddenTag = "";

  push(chunk: string): string {
    this.pending += chunk;
    let visible = "";

    while (this.pending) {
      if (this.hiddenTag) {
        const close = `</${this.hiddenTag}>`;
        const end = this.pending.indexOf(close);
        if (end >= 0) {
          this.pending = this.pending.slice(end + close.length);
          this.hiddenTag = "";
          continue;
        }
        // Retain only the suffix that could be the beginning of the closing
        // tag. Everything else is private control payload.
        this.pending = longestCandidateSuffix(this.pending, [close]);
        break;
      }

      const opening = earliestOpeningTag(this.pending);
      if (opening) {
        visible += this.pending.slice(0, opening.index);
        this.pending = this.pending.slice(opening.index + opening.open.length);
        this.hiddenTag = opening.tag;
        continue;
      }

      const suffix = longestCandidateSuffix(this.pending, OPEN_TAGS);
      visible += this.pending.slice(0, this.pending.length - suffix.length);
      this.pending = suffix;
      break;
    }

    return visible;
  }

  /** Return ordinary pending text; discard an unterminated control payload. */
  flush(): string {
    const value = this.hiddenTag ? "" : this.pending;
    this.pending = "";
    this.hiddenTag = "";
    return value;
  }
}

function earliestOpeningTag(value: string): { index: number; open: string; tag: string } | null {
  let best: { index: number; open: string; tag: string } | null = null;
  for (let index = 0; index < OPEN_TAGS.length; index += 1) {
    const open = OPEN_TAGS[index];
    const at = value.indexOf(open);
    if (at < 0 || (best && at >= best.index)) continue;
    best = { index: at, open, tag: CONTROL_TAGS[index] };
  }
  return best;
}

function longestCandidateSuffix(value: string, candidates: readonly string[]): string {
  const max = Math.min(value.length, Math.max(...candidates.map((item) => item.length - 1), 0));
  for (let size = max; size > 0; size -= 1) {
    const suffix = value.slice(-size);
    if (candidates.some((candidate) => candidate.startsWith(suffix))) return suffix;
  }
  return "";
}
