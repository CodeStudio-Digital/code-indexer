import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import { ModelCatalogIndex } from '../../../indexer/providers/model-catalog-index.js';
import { ModelDiscovery } from '../../../indexer/providers/model-discovery.js';
import { miscTools } from '../misc.js';
import type { IndexToolContext } from '../../context.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture() {
  const db = new CodeIndexDB(':memory:'), store = new ProviderStore(db.raw());
  const d1 = 'Retrieves evidence from specialized journals.', d2 = 'Measures temperatures in weather reports.';
  store.upsertProvider({id:'research-1', name:'Research Lab', kind:'openai', enabled:true, api_key:'secret-example'});
  store.upsertProvider({id:'mirror', name:'Other Cloud', kind:'bedrock', enabled:true});
  store.replaceModelsFromSource('research-1','manual',[
    {model_id:'read-2.1',name:'Read 2.1',description:d1,input_modalities:['text','image'],context_window:500000,supported_reasoning_levels:['low','max']},
    {model_id:'read-2.1.5',name:'Read 2.1.5',description:d1,input_modalities:['text'],context_window:20000},
    {model_id:'weather',name:'Weather',description:d2,input_modalities:['audio'],context_window:8000},
    {model_id:'unknown',name:'No catalog facts'},
  ]);
  store.replaceModelsFromSource('mirror','manual',[{model_id:'read-2.1',name:'Read 2.1',description:d1,input_modalities:['image'],context_window:800000}]);
  const encoder = { fingerprint:()=>'test-encoder-v1',
    embed:vi.fn(async (texts:string[])=>({vectors:texts.map(t=>t.includes('journals')?[1,0]:[0,1]),tokens:0})),
    embedQuery:vi.fn(async (_text:string)=>({vector:[1,0],tokens:0})) };
  const index = new ModelCatalogIndex(db,encoder);
  const owner = vi.fn((...args: Parameters<typeof index.search>) => index.search(...args));
  const discovery = new ModelDiscovery(db, owner);
  const tool = miscTools.find(t=>t.name==='list_models')!;
  const search = async (args:Record<string,unknown>) => {
    const result = await tool.handler(args,{modelDiscovery:discovery} as IndexToolContext);
    if(typeof result==='string') throw Error('Expected a structured page');
    return result.structuredContent as {models:Array<{provider:string;id:string;evidence?:string}>;total:number;next_offset:number|null;search?:{index:string;mode:string}};
  };
  cleanup.push(async()=>{await index.close();db.close();});
  return { db, store, encoder, index, owner, search };
}

describe('model catalog intent search',()=>{
  it('honors literal IDs, versions, explicit account and effort without loading Granite or routing through the owner',async()=>{
    const {search,owner,encoder}=fixture();
    expect(await search({query:'modelo Read 2.1 no Research Lab no máximo'})).toMatchObject({total:1,models:[{provider:'research-1',id:'read-2.1'}]});
    expect(await search({query:'read-2.1',provider:'mirror',requires:{effort:'max'}})).toMatchObject({total:0});
    expect(await search({query:'read-20.1',provider:'research-1'})).toMatchObject({total:0});
    expect(await search({query:'Read 42',provider:'research-1'})).toMatchObject({total:0});
    expect(await search({query:'Read 2.1 via Research Lab',provider:'mirror'})).toMatchObject({total:0});
    expect(owner).not.toHaveBeenCalled(); expect(encoder.embedQuery).not.toHaveBeenCalled();
  });
  it('ranks open questions from real descriptions and applies every declared capability before pagination',async()=>{
    const {search,index,encoder}=fixture(); await index.prepare();
    const args={match:'intent',query:'consultar periódicos científicos',requires:{input_modalities:['image'],min_context:500000},limit:1};
    const first=await search(args), last=await search({...args,offset:1});
    expect(first).toMatchObject({total:2,next_offset:1,search:{mode:'hybrid',index:'ready'}});
    expect(new Set([...first.models,...last.models].map(m=>m.provider))).toEqual(new Set(['mirror','research-1']));
    expect(first.models[0].evidence).toContain('specialized journals');
    expect(encoder.embedQuery).toHaveBeenCalledTimes(1);
    expect(await search({...args,query:'consultar periódicos no Research Lab'})).toMatchObject({total:1,models:[{provider:'research-1'}]});
    expect(await search({...args,query:'consultar periódicos via provedor inexistente'})).toMatchObject({total:0});
    expect(await search({...args,requires:{input_modalities:['video']}})).toMatchObject({total:0});
    expect(JSON.stringify(first)).not.toContain('secret-example');
  });
  it('reuses embeddings after restart, coalesces builds, and processes only distinct changed descriptions',async()=>{
    const {db,index,encoder}=fixture();
    await Promise.all([index.prepare(),index.prepare()]);
    expect(encoder.embed.mock.calls.flatMap(([docs])=>docs)).toHaveLength(2);
    const fresh=new ModelCatalogIndex(db,encoder);
    try {
      await fresh.prepare(); expect(encoder.embed).toHaveBeenCalledTimes(1);
      db.raw().prepare("UPDATE provider_models SET description='Updated notes.' WHERE model_id='weather'").run();
      await fresh.prepare();
      expect(encoder.embed.mock.calls[1][0]).toEqual(['Updated notes.']);
      db.raw().prepare("UPDATE provider_models SET enabled=0 WHERE model_id='weather'").run();
      await fresh.prepare(); expect(encoder.embed).toHaveBeenCalledTimes(2);
      expect(db.raw().prepare('SELECT COUNT(*) FROM model_catalog_embeddings').pluck().get()).toBe(1);
    } finally { await fresh.close(); }
  });
  it('removes a disabled provider even if it changes while the query is being embedded',async()=>{
    const {db,index,encoder,search}=fixture(); await index.prepare();
    let release!:()=>void;
    const gate=new Promise<void>(done=>{release=done;});
    encoder.embedQuery.mockImplementationOnce(async()=>{await gate;return {vector:[1,0],tokens:0};});
    const pending=search({provider:'research-1',match:'intent',query:'find journal references'});
    await vi.waitFor(()=>expect(encoder.embedQuery).toHaveBeenCalled());
    db.raw().prepare("UPDATE provider_configs SET enabled=0 WHERE id='research-1'").run(); release();
    expect(await pending).toMatchObject({models:[],total:0});
  });
  it('keeps the first call responsive during a cold build and serves confirmed facts when inference fails',async()=>{
    const {encoder,search,index}=fixture();
    let fail!: (error: Error)=>void;
    encoder.embed.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{fail=reject;}));
    const args={query:'analisar prints com contexto longo',provider:'research-1'};
    expect(await search(args)).toMatchObject({search:{mode:'metadata',index:'warming'},models:[{id:'read-2.1'}]});
    const joined=index.prepare(); fail(new Error('device offline')); await expect(joined).rejects.toThrow('device offline');
    expect(await search(args)).toMatchObject({search:{mode:'metadata',index:'unavailable'},total:1});
    await index.prepare();
    encoder.embedQuery.mockRejectedValueOnce(new Error('encoder offline'));
    expect(await search(args)).toMatchObject({search:{mode:'metadata',index:'unavailable'},total:1});
    await expect(index.search({query:'q',limit:5,offset:0},AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped');
  });
  it('rejects malformed numeric bounds, modalities, and unsupported live search before any inference',async()=>{
    const {search,owner}=fixture();
    for(const requires of [{min_context:0},{effort:123},{input_modalities:[]},{input_modalities:['%']},{price:2}]) {
      await expect(search({query:'find',requires})).rejects.toThrow();
    }
    await expect(search({live:true,match:'intent',query:'analisar'})).rejects.toThrow();
    expect(owner).not.toHaveBeenCalled();
  });
  it('returns a named result while a slow semantic query is in flight and cancels that query before its encoder returns', async()=>{
    const {encoder,index,search}=fixture();
    await index.prepare();
    let finish!:()=>void;
    encoder.embedQuery.mockImplementationOnce(()=>new Promise(resolve=>{finish=()=>resolve({vector:[1,0],tokens:0});}));
    const controller=new AbortController();
    const pending=index.search({query:'consulta por finalidade',offset:0,limit:2},controller.signal);
    await vi.waitFor(()=>expect(encoder.embedQuery).toHaveBeenCalled());
    expect(await search({query:'read-2.1',provider:'research-1'})).toMatchObject({total:1});
    controller.abort(new Error('turn cancelled'));
    await expect(pending).rejects.toThrow('turn cancelled');
    finish();
    expect((await index.search({query:'consulta por finalidade',offset:0,limit:2})).search?.mode).toBe('hybrid');
    expect(encoder.embedQuery).toHaveBeenCalledTimes(2);
  });
});
