/** Electron-as-Node with --import tsx. Input is a read-only profile DB or an exported public-metadata JSON. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';
import type { UpsertModelInput } from '@mcp/store/provider/types.js';
import type { ProviderName } from '@mcp/shared/types.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { ModelCatalogIndex } from '@mcp/indexer/indexer/providers/model-catalog-index.js';
import { ModelDiscovery } from '@mcp/indexer/indexer/providers/model-discovery.js';
import type { ModelPage } from '@mcp/indexer/indexer/providers/model-catalog-read.js';
import type { CatalogRequirements } from '@mcp/indexer/indexer/providers/catalog-intent.js';
import {catalogTerms,matchCatalogProviders} from '@mcp/shared/providers/catalog-match.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: bench-model-catalog.ts <profile.db | metadata.json> <report.json>');
type Row = Omit<UpsertModelInput,'input_modalities'|'supported_reasoning_levels'> & { provider_id: string; input_modalities: string | null; supported_reasoning_levels: string | null };
type Source = {providers: {id:string; name:string; kind:string}[]; models: Row[]};
function readSource(): Source {
  if (input.endsWith('.json')) return JSON.parse(readFileSync(input,'utf8'));
  const db = new Database(input, { readonly:true, fileMustExist:true });
  try { return {
    providers: db.prepare('SELECT id,name,kind FROM provider_configs WHERE enabled=1 ORDER BY id').all() as Source['providers'],
    models: db.prepare('SELECT m.provider_id,m.model_id,m.name,m.mode,m.display_name,m.description,m.context_window,m.input_modalities,' +
      'm.supported_reasoning_levels,m.can_reason,m.default_reasoning_level,m.supports_attachments FROM provider_models m ' +
      'JOIN provider_configs p ON p.id=m.provider_id WHERE p.enabled=1 AND m.enabled=1 ORDER BY m.provider_id,m.model_id,m.mode').all() as Row[],
  }; } finally { db.close(); }
}
type Probe = { group:'name'|'task'|'validation'|'constraint'|'absence'; query:string; provider?:string; requires?:CatalogRequirements; relevant?:(m:Row)=>boolean };
const tasks: Probe[] = [
  {group:'task',query:'traduzir documentos de um idioma para outro',relevant:m=>/translation model|machine translation/i.test(m.description ?? '')},
  {group:'task',query:'translate between languages while following a glossary',relevant:m=>/translation model|machine translation/i.test(m.description ?? '')},
  {group:'task',query:'transcrever uma gravação de voz em texto',relevant:m=>/transcription|speech.to.text|whisper/i.test(m.model_id+' '+m.description)},
  {group:'task',query:'turn a meeting recording into a written transcript',relevant:m=>/transcription|speech.to.text|whisper/i.test(m.model_id+' '+m.description)},
  {group:'task',query:'ler as letras minúsculas numa foto de um documento',relevant:m=>/OCR|document parsing|document recognition/i.test(m.description ?? '')},
  {group:'task',query:'extract the printed words visible in a photograph',relevant:m=>/OCR|document parsing|document recognition/i.test(m.description ?? '')},
  {group:'task',query:'representar frases como vetores para busca por similaridade',provider:'cloudflare',relevant:m=>/embedding|bge-/i.test(m.model_id+' '+m.description)},
  {group:'task',query:'fill in missing source code between a prefix and a suffix',relevant:m=>/fill.in.the.middle|code infilling/i.test(m.description ?? '')},
  {group:'task',query:'completar um trecho de código entre o prefixo e o sufixo',relevant:m=>/fill.in.the.middle|code infilling/i.test(m.description ?? '')},
  {group:'constraint',query:'quero analisar prints com contexto longo',relevant:m=>!!m.input_modalities?.includes('"image"') && (m.context_window??0)>=128000},
  {group:'constraint',query:'read screenshots with at least 500k tokens',relevant:m=>!!m.input_modalities?.includes('"image"') && (m.context_window??0)>=500000},
  {group:'constraint',query:'',requires:{input_modalities:['audio','video'],min_context:100000},relevant:m=>!!m.input_modalities?.includes('"audio"') && !!m.input_modalities?.includes('"video"') && (m.context_window??0)>=100000},
  {group:'name',query:'Sol 6.2',provider:'ChatGPT',requires:{effort:'max'},relevant:m=>m.provider_id==='openai-chatgpt' && m.model_id==='gpt-6.2-sol' && !!m.supported_reasoning_levels?.includes('"max"')},
  {group:'absence',query:'Sol 64.93',provider:'ChatGPT'},
  {group:'absence',query:'read photographs',provider:'missing-account-xyz'},
  {group:'absence',query:'',requires:{min_context:100_000_000}},
  {group:'absence',query:'Sol 6.2',provider:'ChatGPT',requires:{input_modalities:['video']}},
  // Additional paraphrases frozen before comparing ranking changes. Labels refer to published descriptions.
  {group:'validation',query:'condense a lengthy report into a short overview',relevant:m=>/summari[sz]|summarize/i.test(m.description ?? '')},
  {group:'validation',query:'responder perguntas sobre o conteúdo visível de uma fotografia',relevant:m=>/visual question answering|visual reasoning|visual understanding/i.test(m.description ?? '')},
  {group:'validation',query:'operate a desktop by looking at the screen',provider:'ChatGPT',relevant:m=>/computer use/i.test(m.description ?? '')},
  {group:'validation',query:'devolver dados obedecendo aos campos de um esquema JSON',relevant:m=>/structured output|json schema/i.test(m.description ?? '')},
  {group:'validation',query:'make German instructions readable for a French speaker',relevant:m=>/translation model|machine translation/i.test(m.description ?? '')},
  {group:'validation',query:'criar uma representação numérica de sentenças semanticamente parecidas',provider:'cloudflare',relevant:m=>/embedding|bge-/i.test(m.model_id+' '+m.description)},
  {group:'validation',query:'colocar no papel o que as pessoas disseram durante a reunião gravada',relevant:m=>/transcription|speech.to.text|whisper/i.test(m.model_id+' '+m.description)},
];
const source=readSource();
// Exact-ID probes cover all enabled accounts, including gateways that offer the same model.
const key = (m: Row) => m.model_id+(m.mode?'::'+m.mode:'');
const names: Probe[] = source.providers.flatMap(p=>{
  const rows=source.models.filter(m=>m.provider_id===p.id);
  if(!rows.length) return [];
  const row=rows[Math.floor(rows.length/2)];
  return [{group:'name' as const,query:key(row),provider:p.id,relevant:(m:Row)=>m.provider_id===p.id && key(m)===key(row)}];
});
const probes=[...names,...tasks];
const root=dirname(resolve(output)); mkdirSync(root,{recursive:true});
const scratchRoot=resolve('.tmp/model-catalog-eval'); mkdirSync(scratchRoot,{recursive:true});
const scratch=mkdtempSync(join(scratchRoot,'db-'));
const db=new CodeIndexDB(join(scratch,'catalog.db')), store=new ProviderStore(db.raw());
for(const p of source.providers){
  store.upsertProvider({...p,enabled:true});
  store.replaceModelsFromSource(p.id,'manual',source.models.filter(m=>m.provider_id===p.id).map(m=>({...m,enabled:true,can_reason:!!m.can_reason,
    supports_attachments:!!m.supports_attachments,input_modalities:JSON.parse(m.input_modalities??'null'),supported_reasoning_levels:JSON.parse(m.supported_reasoning_levels??'null')})));
}
const fields=new ModelDiscovery(db), encoder=new LocalEmbeddingService();
let encoded=0;
const measuredEncoder={fingerprint:()=>encoder.fingerprint(),embedQuery:(text:string)=>encoder.embedQuery(text),
  async embed(texts:string[]){const result=await encoder.embed(texts);encoded+=texts.length;return result;}};
const semantic=new ModelCatalogIndex(db,measuredEncoder);
const hybrid=new ModelDiscovery(db,(request,signal)=>semantic.search(request,signal));
const byId=new Map(source.models.map(m=>[m.provider_id+'\n'+key(m),m]));
/** The pre-hybrid SQL, frozen so subsequent fixes to exact-ID/version ranking cannot improve the baseline. */
async function namesBeforeHybrid(probe: Probe): Promise<ModelPage> {
  const predicates=['p.enabled=1','m.enabled=1'], parameters:string[]=[];
  if(probe.provider) {
    const ids=matchCatalogProviders(store.listProviderIdentities(),probe.provider).map(p=>p.id);
    if(!ids.length) return {models:[],total:0,offset:0};
    predicates.push('p.id IN ('+ids.map(()=>'?').join(',')+')');
    parameters.push(...ids);
  }
  const searchable="lower(m.model_id || ' ' || m.name || ' ' || coalesce(m.display_name,'') || ' ' || m.mode)";
  for(const term of new Set(catalogTerms(probe.query))){
    if(/^\d+(?:\.\d+)+$/.test(term)){
      predicates.push("(' ' || "+searchable+" || ' ') GLOB ?"); parameters.push('*[^0-9]'+term+'[^0-9]*');
    } else {predicates.push('instr('+searchable+', ?) > 0'); parameters.push(term);}
  }
  const from=' FROM provider_models m JOIN provider_configs p ON p.id=m.provider_id WHERE '+predicates.join(' AND ');
  const raw=db.raw();
  return raw.transaction(()=>{
    const total=raw.prepare('SELECT COUNT(*)'+from).pluck().get(...parameters) as number;
    const rows=raw.prepare("SELECT p.id AS provider,m.model_id || CASE WHEN m.mode!='' THEN '::'||m.mode ELSE '' END AS id,m.name,m.updated_at AS cached_at"+
      from+' ORDER BY p.name,p.id,m.name,m.mode,m.model_id LIMIT 5 OFFSET 0').all(...parameters) as Array<{provider:ProviderName;id:string;name:string;cached_at:string}>;
    return {models:rows.map(m=>({...m,capabilities:['text']})),total,offset:0};
  })();
}
const percentile=(values:number[],p:number)=>Number([...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(p*values.length)-1)]?.toFixed(2));
interface Observation {
  mode:string; group:Probe['group']; query:string; provider?:string; requires?:CatalogRequirements;
  rank:number; correct:boolean; wrongProvider:boolean; returned:number; search?:string; top:string[][];
}
const cases:Observation[]=[];
const summary:Record<string,unknown>={};
const probesFor = async (mode:string, lookup:(q:Probe)=>Promise<ModelPage>)=>{
  const all:number[]=[], named:number[]=[], open:number[]=[], first:number[]=[], initialTask:number[]=[];
  for(const probe of probes){
    let page: ModelPage | undefined;
    for(let round=0; round<5; round++){
      const start=performance.now(); page=await lookup(probe); const elapsed=performance.now()-start;
      if(!round) { first.push(elapsed); if(probe.group==='task'||probe.group==='validation') initialTask.push(elapsed); }
      else { all.push(elapsed); (probe.group==='name'?named:open).push(elapsed); }
    }
    const ids=page!.models.map(m=>[m.provider,m.id]);
    const rank=ids.findIndex(([p,id])=>{const row=byId.get(p+'\n'+id);return !!row && !!probe.relevant?.(row);})+1;
    const correct=probe.group==='absence' ? ids.length===0 : rank===1;
    const expectedAccount=probe.provider==='ChatGPT'?'openai-chatgpt':probe.provider;
    cases.push({mode,group:probe.group,query:probe.query,provider:probe.provider,requires:probe.requires,rank,correct,
      wrongProvider:expectedAccount ? ids.some(([p])=>p!==expectedAccount):false,returned:page!.total,search:page!.search?.mode,top:ids.slice(0,5)});
  }
  const measured=cases.filter(v=>v.mode===mode);
  summary[mode]={probes:measured.length,top1:measured.filter(v=>v.correct).length,wrongProvider:measured.filter(v=>v.wrongProvider).length,
    byGroup:Object.fromEntries(['name','task','validation','constraint','absence'].map(group=>{const g=measured.filter(v=>v.group===group);
      return [group,{n:g.length,top1:g.filter(v=>v.correct).length,top5:g.filter(v=>v.correct||v.rank>0).length}];})),
    firstLookupP95Ms:percentile(first,.95),firstTaskP95Ms:percentile(initialTask,.95),
    warmP50Ms:percentile(all,.5),warmP95Ms:percentile(all,.95),warmNameP95Ms:percentile(named,.95),warmOtherP95Ms:percentile(open,.95)};
};
try {
  await probesFor('name-only',namesBeforeHybrid);
  const run=(service:ModelDiscovery)=>(p:Probe)=>service.discoverPage(p.provider as ProviderName|undefined,false,0,5,{query:p.query||undefined,requires:p.requires});
  await probesFor('metadata',run(fields));
  const start=performance.now(); await semantic.prepare(); const buildMs=Math.round(performance.now()-start);
  await probesFor('hybrid',run(hybrid));
  const embeddedDescriptions=encoded;
  const reopened=new ModelCatalogIndex(db,measuredEncoder);
  const restoreStart=performance.now(); await reopened.prepare(); const restoreMs=Math.round(performance.now()-restoreStart);
  const reencodedOnRestart=encoded-embeddedDescriptions;
  const changed=source.models.find(m=>m.description)!;
  db.raw().prepare('UPDATE provider_models SET description=? WHERE provider_id=? AND model_id=? AND mode=?').run(
    changed.description+' Synthetic evaluation edit.',changed.provider_id,changed.model_id,changed.mode??'');
  const beforeEdit=encoded, editStart=performance.now(); await reopened.prepare();
  const incrementalMs=Math.round(performance.now()-editStart),reencodedOnEdit=encoded-beforeEdit;
  await reopened.close();
  const report={models:source.models.length,providers:source.providers.length,withDescription:source.models.filter(m=>m.description).length,
    method:'Public metadata copied to isolated SQLite; known IDs and description-based labels in Portuguese and English. First lookup plus four warm repetitions per query. Absence probes count as correct only with zero results.',
    embeddedDescriptions,buildMs,restoreMs,reencodedOnRestart,incrementalMs,reencodedOnEdit,encoder:encoder.diagnostics(),summary,cases};
  writeFileSync(output,JSON.stringify(report,null,2)); console.log(JSON.stringify({...report,cases:undefined},null,2));
  if(reencodedOnRestart!==0 || reencodedOnEdit!==1 || cases.some(c=>c.mode==='hybrid' && (c.wrongProvider ||
    (['name','constraint','absence'].includes(c.group) && !c.correct)))) throw Error('Model catalog contract regression');
} finally {
  await semantic.close(); await encoder.dispose(); db.close();
  if(dirname(resolve(scratch))===scratchRoot) rmSync(scratch,{recursive:true,force:true});
}
