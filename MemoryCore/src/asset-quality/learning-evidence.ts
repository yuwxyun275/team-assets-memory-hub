/** Exact, bounded source spans. IDs select existing bytes/UTF-16 spans, never model-authored evidence. */
export function learningExcerpts(source: { id: string; content: string }) {
  const excerpts: Array<{ excerpt_id: string; start: number; end: number; quote: string }> = [];
  let start = 0;
  while (start < source.content.length) {
    let end = Math.min(start + 800, source.content.length);
    const newline = source.content.lastIndexOf('\n', end - 1);
    if (newline >= start + 200) end = newline + 1;
    if (end < source.content.length && /[\uD800-\uDBFF]/.test(source.content[end - 1])) end--;
    excerpts.push({ excerpt_id: `span-${start}-${end}`, start, end, quote: source.content.slice(start, end) });
    start = end;
  }
  return excerpts;
}
