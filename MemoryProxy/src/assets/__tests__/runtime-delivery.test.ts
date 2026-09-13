import {describe,it,expect,vi} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AssetDelivery,modelInputTexts} from '../delivery.js';
import {AssetHistoryStore,historyScope} from '../history-store.js';
import {resolveRuntimeContext,runtimeTurnAnchor,confirmedWorkspace} from '../runtime-context.js';
import {messageFingerprint,compactionBoundary} from '../history.js';
import {extractUserQueryText} from '../../common/user-query-extractor.js';
import {qualityEvents} from '../../injection/injectors/quality-observer.js';

const message=(content:string,role:any='user')=>({role,blocks:[{type:'text' as const,content}]});
const summary='<system_reminder>transport</system_reminder>\n<cb_summary>Summary of the conversation so far:\n<previous_user_message><user_query>旧问题：修改代码</user_query></previous_user_message>\n<previous_tool_call>9 passed</previous_tool_call>\n</cb_summary>\n<additional_data>clock</additional_data>\n<user_query>新问题：只整理报告</user_query>';
const session={user_id:'user',team_id:'team',agent_id:'agent',task_id:'task',session_id:'session'};
const scope=historyScope({space:'space',user:'user',team:'team',agent:'agent',task:'task',session:'session',source:'codebuddy'});
const context=(messages:any[],workspace='/workspace'):any=>({messages,metadata:{userId:'user',spaceId:'space',agentSource:'codebuddy',turnSeq:1,assetDelivery:new AssetDelivery(),custom:{session,workspaceFolder:workspace}}});
const newStore=async()=>new AssetHistoryStore(await mkdtemp(join(tmpdir(),'asset-runtime-')));

describe('CodeBuddy summary is transport data, not a fresh user question or tool evidence',()=>{
  it('keeps only the current query and recognizes the complete envelope',()=>{
    expect(extractUserQueryText(summary)).toBe('新问题：只整理报告');
    expect(compactionBoundary([message(summary)])).toBe(0);
    expect(compactionBoundary([message('<system_reminder>rules</system_reminder><user_query>继续</user_query>'),message(summary)])).toBe(1);
    expect(compactionBoundary([message('这是一个引文'),message(summary)])).toBeUndefined();
    expect(compactionBoundary([message('下面是引用：'+summary)])).toBeUndefined();
    expect(qualityEvents([message(summary)])).toEqual([expect.objectContaining({role:'user',content:'新问题：只整理报告'})]);
  });
  it('retains real tool/result associations without promoting quoted outputs',()=>{
    const events=qualityEvents([{role:'assistant',blocks:[{type:'tool_use',content:'unittest',metadata:{tool_id:'call-1'}}]},
      {role:'tool',blocks:[{type:'tool_result',content:'9 passed',metadata:{tool_use_id:'call-1'}}]}] as any);
    expect(events.map(e=>e.tool_call_id)).toEqual(['call-1','call-1']);
  });
});
describe('durable logical turns',()=>{
  it('accepts an explicit current-turn workspace confirmation but not an old summary quotation',async()=>{
    expect(confirmedWorkspace([message('确认当前工作区：/correct\n继续收尾')])).toBe('/correct');
    expect(confirmedWorkspace([message(summary.replace('旧问题：修改代码','确认当前工作区：/old'))])).toBe('');
    expect(confirmedWorkspace([message('确认当前工作区：/\n继续')])).toBe('');
    const store=await newStore(),ctx=context([message('确认当前工作区：/confirmed\n继续')],'');
    await resolveRuntimeContext(ctx,store);
    expect(ctx.metadata.custom.workspaceFolder).toBe('/confirmed');
    const compressed=context([message(summary)],''); await resolveRuntimeContext(compressed,store);
    expect(compressed.metadata.custom.workspaceFolder).toBe('/confirmed');
  });
  it('survives compression, restart, retries and tool loops without reusing earlier numbers',async()=>{
    const store=await newStore(), floor=vi.fn(async()=>6);
    const first=context([message('检查缓存')]); await resolveRuntimeContext(first,store,floor);
    expect(first.metadata.turnSeq).toBe(7);
    const toolLoop=context([message('检查缓存'),message('读取代码','assistant'),{role:'tool',blocks:[{type:'tool_result',content:'body'}]}]);
    await resolveRuntimeContext(toolLoop,store,floor); expect(toolLoop.metadata.turnSeq).toBe(7);
    const compact=context([message(summary)],''); compact.metadata.turnSeq=2;
    await resolveRuntimeContext(compact,new AssetHistoryStore(store.directory),floor);
    expect(compact.metadata.turnSeq).toBe(8); expect(compact.metadata.custom.workspaceFolder).toBe('/workspace');
    const retry=context([message(summary)],''); await resolveRuntimeContext(retry,store,floor);
    expect(retry.metadata.turnSeq).toBe(8); expect(floor).toHaveBeenCalledOnce();
    expect(retry.metadata.assetDelivery.turnSeq).toBe(8);
  });
  it('does not confuse two identical Continue messages at different positions',()=>{
    expect(runtimeTurnAnchor([message('继续')])).not.toBe(runtimeTurnAnchor([message('继续'),message('完成','assistant'),message('继续')]));
  });
  it('does not inherit workspace across an unrecognized history rewrite or another task',async()=>{
    const store=await newStore(); await resolveRuntimeContext(context([message('原始问题')]),store);
    const rewritten=context([message('新的完全无关问题')],''); await resolveRuntimeContext(rewritten,store);
    expect(rewritten.metadata.custom.workspaceFolder).toBe('');
    const other=context([message(summary)],''); other.metadata.custom.session={...session,task_id:'other'};
    await resolveRuntimeContext(other,store); expect(other.metadata.custom.workspaceFolder).toBe('');
  });
  it('ignores exact Proxy-owned echoes when calculating the human turn',async()=>{
    const store=await newStore(), first=context([message('检查')]); await resolveRuntimeContext(first,store);
    await store.transaction(scope,async s=>{s.entries.push({id:'e',anchor:'a',content:'old card',refs:[],active:true,created:1,kind:'append'});});
    const echo=context([message('检查'),message('old card')]); await resolveRuntimeContext(echo,store);
    expect(echo.metadata.turnSeq).toBe(first.metadata.turnSeq);
  });
  it('migrates old history only using a bound workspace and two exact retained messages',async()=>{
    const store=await newStore(), retained=[message('工具调用','assistant'),message('真实输出','tool')];
    await store.transaction(scope,async s=>{s.lastMessages=retained.map(messageFingerprint);s.entries.push({id:'e',anchor:'a',content:'card',refs:[],active:true,created:1,kind:'append'});});
    const ctx=context([message(summary),...retained],''); ctx.metadata.custom.taskDetail={sourceType:'other',sourceUrl:'/bound-workspace'};
    await resolveRuntimeContext(ctx,store,async()=>12);
    expect(ctx.metadata.turnSeq).toBe(13); expect(ctx.metadata.custom.workspaceFolder).toBe('/bound-workspace');
  });
  it('recovers a fully compressed legacy task only when summary confirms its existing workspace binding',async()=>{
    const store=await newStore();await store.transaction(scope,async s=>{s.entries.push({id:'e',anchor:'a',content:'card',refs:[],active:true,created:1,kind:'append'});});
    const ctx=context([message(summary.replace('旧问题：修改代码','旧问题：修改代码；工作区 /bound-workspace。'))],'');
    ctx.metadata.custom.taskDetail={sourceType:'other',sourceUrl:'/bound-workspace'};
    await resolveRuntimeContext(ctx,store,async()=>12);
    expect(ctx.metadata.custom.workspaceFolder).toBe('/bound-workspace');
    expect(ctx.metadata.custom.workspaceSource).toBe('bound_task_confirmed_in_client_summary');
    expect(ctx.metadata.turnSeq).toBe(13);
  });
});
describe('acknowledge only accepted final model input',()=>{
  it.each([400,429,500])('does not acknowledge HTTP %i',async status=>{
    const d=new AssetDelivery(), work=vi.fn();d.defer(work);await d.accept({messages:[{content:'card'}]},status);expect(work).not.toHaveBeenCalled();
  });
  it('has no prepare side effect and acknowledges a successful request once',async()=>{
    const d=new AssetDelivery(), work=vi.fn(async()=>{});d.defer(work);expect(work).not.toHaveBeenCalled();
    await d.accept({messages:[{content:'actually sent'}]},200); await d.accept({messages:[]},200);
    expect(work).toHaveBeenCalledExactlyOnceWith(['actually sent']);
  });
  it('discards failed pipelines and excludes metadata/tool descriptions from evidence',async()=>{
    const d=new AssetDelivery(), work=vi.fn();d.defer(work);d.discard();await d.accept({messages:[]},200);expect(work).not.toHaveBeenCalled();
    expect(modelInputTexts({tools:[{description:'not sent as context'}],metadata:{card:'hidden'},input:[{type:'function_call_output',output:'real output'}],messages:[{role:'user',content:[{text:'question'}]}]})).toEqual(['question','real output']);
  });
});
