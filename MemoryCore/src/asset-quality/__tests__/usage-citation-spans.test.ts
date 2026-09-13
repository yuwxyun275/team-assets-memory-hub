import { describe, it, expect } from "vitest";
import { usageCitationSpans, usageEvidenceKind, validateUsageResult } from "../usage-result.js";
describe("exact citation handles", () => {
  const events = [{ id: "event1", role: "tool_result", content: JSON.stringify({stdout:'test_cache_recovery ... ok\r\nRan 9 tests\r\nOK'}) }];
  it("resolves a model-selected handle to unchanged stored event text", () => {
    const spans = usageCitationSpans(events);
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every(s => events[0].content.includes(s.quote))).toBe(true);
    const result = validateUsageResult({outcome:"helpful",reason:"recovery check matches asset",citations:[{span_id:spans[0].span_id}]},events);
    expect(result.citations).toEqual([{event_id:"event1",quote:spans[0].quote}]);
  });
  it("rejects invented handles or model-supplied overrides", () => {
    for(const c of [{span_id:"invented"},{span_id:usageCitationSpans(events)[0].span_id,quote:"fake"}]) {
      expect(()=>validateUsageResult({outcome:"helpful",reason:"x",citations:[c]},events)).toThrow("invalid_citation");
    }
  });
  it("does not create handles for assistant self-reports", () => {
    expect(usageCitationSpans([{id:"a",role:"assistant",content:"9 tests passed"}])).toEqual([]);
  });
  it("requires a quote from this asset, not from another asset in subsequent events",()=>{
    const result={outcome:'helpful',reason:'matches',asset_quote:'恢复后不查数据库',citations:[{event_id:'event1',quote:'test_cache_recovery'}]};
    expect(()=>validateUsageResult(result,events,'调用图：FlagService.read → Cache.get')).toThrow('invalid_asset_citation');
    expect(()=>validateUsageResult({...result,asset_quote:undefined},events,'恢复后不查数据库')).toThrow('invalid_asset_citation');
    expect(validateUsageResult(result,events,'必须断言恢复后不查数据库').outcome).toBe('helpful');
  });
  it.each(['write_to_file','apply_patch','open_result_view'])("does not count %s report echoes as verification",name=>{
    const log=[{id:'c',role:'tool_call',tool_call_id:'call',content:JSON.stringify({name,arguments:'generated RESULT.md'})},
      {id:'r',role:'tool_result',tool_call_id:'call',content:'Report written: recovery tests passed'}];
    expect(usageEvidenceKind(log[1],log)).toBe('generated_artifact');
    expect(usageCitationSpans(log)).toHaveLength(0);
    expect(()=>validateUsageResult({outcome:'helpful',reason:'matches',asset_quote:'test recovery',citations:[{event_id:'r',quote:'recovery tests passed'}]},log,'test recovery')).toThrow('missing_evidence');
  });
  it('recognizes chunked tool-call metadata and preserves genuine test outputs',()=>{
    const events=[{id:'c',role:'tool_call',tool_call_id:'write',content:'{"name":"write_to_file","arguments":"truncated'},
      {id:'r',role:'tool_result',tool_call_id:'write',content:'9 tests passed'},
      {id:'t',role:'tool_result',tool_call_id:'test',content:'test_recovery passed'}];
    expect(usageEvidenceKind(events[1],events)).toBe('generated_artifact');
    expect(usageCitationSpans(events).map(s=>s.event_id)).toEqual(['t']);
  });
  it.each(['',null])('accepts an absent optional asset quote for unobserved only: %j',asset_quote=>{
    expect(validateUsageResult({outcome:'unobserved',reason:'No observed connection',asset_quote,citations:[]},events,'test recovery')).not.toHaveProperty('asset_quote');
    expect(()=>validateUsageResult({outcome:'helpful',reason:'matches',asset_quote,citations:[{event_id:'event1',quote:'test_cache_recovery'}]},events,'test recovery')).toThrow();
  });
});
