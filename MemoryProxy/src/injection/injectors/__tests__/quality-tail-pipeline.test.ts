import { afterEach, describe, expect, it, vi } from 'vitest';
import { InjectionPipeline } from '../../pipeline.js';
import { HookRegistryImpl } from '../../registry.js';
import { OpenAIAdapter } from '../../adapters/openai.js';
import { AnthropicAdapter } from '../../adapters/anthropic.js';

describe('cache-friendly tail injection through actual protocol serialization', () => {
  afterEach(()=>vi.restoreAllMocks());
  it.each(['openai','anthropic'])('keeps %s history and tool results unchanged when assets change', async protocol => {
    vi.spyOn(console,'log').mockImplementation(()=>{});
    const adapter=protocol==='openai'?new OpenAIAdapter():new AnthropicAdapter();
    const metadata:any={protocol,traceId:'trace',keyId:'test',modelId:'test',stream:false,agentSource:'codebuddy'};
    const input:any=protocol==='openai'?{model:'test',messages:[
      {role:'system',content:'stable system'}, {role:'user',content:'fix cache'},
      {role:'assistant',content:null,tool_calls:[{id:'t',type:'function',function:{name:'test',arguments:'{}'}}]},
      {role:'tool',tool_call_id:'t',content:'actual output'},
    ]}:{model:'test',max_tokens:100,system:'stable system',messages:[
      {role:'user',content:[{type:'text',text:'fix cache'}]},
      {role:'assistant',content:[{type:'tool_use',id:'t',name:'test',input:{}}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'t',content:'actual output'}]},
    ]};
    const original=JSON.stringify(input), baseline=adapter.serialize(adapter.parse(input,metadata));
    const registry=new HookRegistryImpl(); let content='asset version 1';
    const onApplied=vi.fn(async(ctx:any)=>expect(ctx.messages.at(-1).blocks[0].content).toBe(content));
    registry.register({id:'test-tail',description:'Verify dynamic context is appended after unchanged history',point:'context.tail',priority:100,execute:async()=>[{type:'text',content}],onApplied});
    const pipeline=new InjectionPipeline(registry,new Map([[protocol,adapter]]));
    for (const next of ['asset version 1','different asset version 2']) {
      content=next; const result=await pipeline.process(input,metadata);
      expect((result.messages as any[]).slice(0,-1)).toEqual(baseline.messages);
      expect(result.system).toEqual(baseline.system);
      expect(JSON.stringify(input)).toBe(original);
    }
    expect(onApplied).toHaveBeenCalledTimes(2);
  });
});
