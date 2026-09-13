import { describe, expect, it, vi } from 'vitest';
import { buildEvidenceCatalog, createModelReviewer } from '../model-reviewer.js';
import { evaluateQuality } from '../evaluator.js';
import { sourceTexts } from '../rules.js';
import { snapshot } from './fixtures.js';

describe('exact evidence catalog', () => {
  it('retains every source character and stable, bounded original positions', () => {
    const s=snapshot(); s.body=('中'.repeat(1199)+'🙂\n').repeat(3);
    const catalog=buildEvidenceCatalog(s);
    for (const [id,text] of sourceTexts(s)) {
      const entries=catalog.filter(e=>e.source_id===id);
      expect(entries.map(e=>e.text).join('')).toBe(text);
      for(const e of entries) { expect(text.slice(e.start,e.end)).toBe(e.text); expect(e.text.length).toBeLessThanOrEqual(1200); }
    }
    expect(buildEvidenceCatalog(s)).toEqual(catalog);
  });
  it('resolves identifiers to unchanged JSON and code rather than model-reconstructed quotations', async () => {
    const s=snapshot('code_graph');
    const reviewer=createModelReviewer('catalog-oracle',()=>({run:async p=>{
      const {criteria,evidence_catalog:catalog}=JSON.parse(p.prompt);
      return JSON.stringify({checks:criteria.map((c:any)=>({id:c.id,status:'pass',score:4,reason:'合成契约测试，不代表准确率',evidence:[
        {evidence_id:catalog.find((e:any)=>e.source_id==='asset').id},
        ...(c.supportKinds?[{evidence_id:catalog.find((e:any)=>e.source_id==='code').id}]:[]),
      ]}))});
    }}));
    const result=await evaluateQuality(s,{reviewer});
    expect(result.decision).toBe('pass');
    for(const c of result.checks) for(const e of c.evidence) expect(sourceTexts(s).get(e.source_id)?.slice(e.start,e.end)).toBe(e.quote);
  });
  it('does not accept fabricated evidence identifiers', async () => {
    const reviewer=createModelReviewer('invalid',()=>({run:async p=>JSON.stringify({checks:JSON.parse(p.prompt).criteria.map((c:any)=>({id:c.id,status:'pass',score:4,reason:'invalid reference',evidence:[{evidence_id:'forged'}]}))})}));
    const result=await evaluateQuality(snapshot(),{reviewer});
    expect(result.reviewer.status).toBe('invalid_response'); expect(result.scorecard?.quality).toBeNull();
  });
  it('rejects an explicit position which does not match the cited text', async () => {
    const s=snapshot();
    const reviewer=createModelReviewer('invalid',()=>({run:async p=>JSON.stringify({checks:JSON.parse(p.prompt).criteria.map((c:any)=>({id:c.id,status:'pass',score:4,reason:'wrong position',evidence:[{source_id:'asset',quote:s.body,start:1}]}))})}));
    expect((await evaluateQuality(s,{reviewer})).reviewer.status).toBe('invalid_response');
  });
  it('allows exactly one reference repair and accepts unknown instead of demanding a pass', async () => {
    const run=vi.fn(async (p:any)=>{
      const {criteria,evidence_catalog:catalog,reference_contract_errors:errors}=JSON.parse(p.prompt);
      return JSON.stringify({checks:criteria.map((c:any)=>({id:c.id,status:errors&&c.supportKinds?'unknown':'pass',score:errors&&c.supportKinds?null:3,reason:'证据契约测试',evidence:[{evidence_id:catalog.find((e:any)=>e.source_id==='asset').id}]}))});
    });
    const result=await evaluateQuality(snapshot(),{reviewer:createModelReviewer('repair-oracle',()=>({run}))});
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.decision).toBe('needs_evidence'); expect(result.scorecard?.quality).toBeNull();
    expect(JSON.parse(run.mock.calls[1][0].prompt).reference_contract_errors[0]).toContain('supporting');
  });
  it('does not repeat a valid low score in search of a better one', async () => {
    const run=vi.fn(async(p:any)=>{
      const {criteria,evidence_catalog:catalog}=JSON.parse(p.prompt);
      return JSON.stringify({checks:criteria.map((c:any)=>({id:c.id,status:'pass',score:2,reason:'基本满足但仍可改进',evidence:[{evidence_id:catalog.find((e:any)=>e.source_id==='asset').id},...(c.supportKinds?[{evidence_id:catalog.find((e:any)=>e.source_id==='reference').id}]:[])]}))});
    });
    const result=await evaluateQuality(snapshot(),{reviewer:createModelReviewer('low-oracle',()=>({run}))});
    expect(run).toHaveBeenCalledOnce(); expect(result.scorecard?.quality).toBe(50);
  });
});
