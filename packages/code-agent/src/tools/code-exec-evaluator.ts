/** Self-contained Node entrypoint, embedded in the bundle so ASAR needs no sidecar. */
export const CODE_EXEC_EVALUATOR = String.raw`
'use strict';
const vm = require('node:vm');
const readline = require('node:readline');
const MAX_FRAME = 16 * 1024 * 1024;
const pending = new Map();
let sequence = 0, bootstrap, heartbeat, previousCpu = process.cpuUsage(), cpuMs = 0;
function encode(error) {
  const out = { name: error?.name || 'Error', message: error?.message || String(error) };
  for (const k of ['code','tool','detail','kind','retryable','suggestedAction','refusalKind','guardVerdict']) {
    if (error?.[k] !== undefined) out[k] = error[k];
  }
  return out;
}
function send(frame) {
  const json = JSON.stringify(frame);
  if (Buffer.byteLength(json) > MAX_FRAME) throw new Error('code_exec IPC frame exceeds 16 MiB');
  process.stdout.write(json + '\n');
}
function rpc(kind, name, args) {
  if (++sequence > 128) return Promise.reject(new Error('code_exec IPC request budget exceeded'));
  const id = sequence;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, {resolve,reject});
    try { send({type:'invoke', id, kind, name, args}); }
    catch (error) { pending.delete(id); reject(error); }
  });
  promise.catch(() => {});
  return promise;
}
async function evaluate(b) {
  bootstrap = b;
  const names = new Set(b.tools);
  const toolFns = Object.fromEntries(b.tools.map(name => [name, args => rpc('tool', name, args)]));
  const tools = new Proxy(toolFns, { get(target, name) {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return target[name] || (args => rpc('tool', name, args));
  }});
  const stash = new Map(b.stash);
  const byteSize = value => Buffer.byteLength(JSON.stringify(value));
  const usedBytes = () => [...stash].reduce((n,[k,v]) => n + Buffer.byteLength(k) + byteSize(v), 0);
  const localStash = {
    get: k => { const v=stash.get(String(k)); return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
    keys: () => [...stash.keys()], usedBytes,
    delete: k => { const removed=stash.delete(String(k)); send({type:'stash',op:'delete',key:String(k)}); return removed; },
    set: (k,v) => {
      k=String(k); const json=JSON.stringify(v);
      if (json === undefined) throw new Error('stash value must be JSON serializable');
      const old=stash.has(k) ? Buffer.byteLength(k)+byteSize(stash.get(k)) : 0;
      if (usedBytes()-old+Buffer.byteLength(k)+Buffer.byteLength(json)>(b.stashMaxBytes??2000000)) throw new Error('stash.set: cap '+(b.stashMaxBytes??2000000)+' bytes exceeded');
      const value=JSON.parse(json); stash.set(k,value); send({type:'stash',op:'set',key:k,value});
    },
  };
  const schemas = new Map(b.schemas.map(s => [s.name,s]));
  const listTools = (options) => {
    const filtered = b.listing.filter(t => !options?.query || (t.name+' '+t.description).toLowerCase().includes(String(options.query).toLowerCase()));
    if (!options) {
      if (filtered.length>100) throw new Error('Catalog has '+filtered.length+' entries; use list_tools({limit:50,cursor:"0"}) for bounded pages.');
      return filtered;
    }
    const offset = Math.max(0, Math.floor(Number(options.cursor)||0));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit)||50)));
    return {items:filtered.slice(offset,offset+limit), nextCursor: offset+limit<filtered.length ? String(offset+limit):null, total:filtered.length};
  };
  const toolSchema = name => {
    const found=schemas.get(String(name));
    if (!found) {
      const retired=b.retired?.[String(name)];
      if (retired) throw new Error('tool_schema: '+retired);
      const close=[...schemas.keys()].find(key=>key.startsWith(String(name)) || String(name).startsWith(key));
      throw new Error('tool_schema: unknown tool "'+name+'"'+(close?' — did you mean "'+close+'"?':'')+'. Use list_tools({query,limit,cursor}) or find_tools.');
    }
    return structuredClone(found);
  };
  const attempt = operation => {
    const p=Promise.resolve(operation).then(value => ({ok:true,value}), error => {
      if (error?.name !== 'NestedToolExecutionError' || ['refusal','permission','timeout','cancelled'].includes(error.kind)
          || String(error.code).includes('OUTCOME_UNKNOWN')) throw error;
      return {ok:false,error:{tool:error.tool,code:error.code,kind:error.kind,message:error.detail,retryable:error.retryable,
        ...(error.suggestedAction?{suggestedAction:error.suggestedAction}:{})}};
    }); p.catch(()=>{}); return p;
  };
  let logBytes=0, omittedLines=0, omittedBytes=0;
  let lastError=null;
  const log = (level,parts) => {
    const normalized=parts.map(p => typeof p === 'string' ? p : p instanceof Error ? p.message : JSON.stringify(p));
    const text=normalized.join(' '); const size=Buffer.byteLength(text);
    if(logBytes>=Math.max(b.maxOutputBytes*2,65536)) {
      if(level==='error') {
        if(lastError){omittedLines++;omittedBytes+=lastError.size+1;}
        lastError={text:text.slice(-b.priorityErrorBytes),size};
      } else {omittedLines++;omittedBytes+=size+1;}
      return;
    }
    logBytes+=size+1;
    send({type:'log',level,parts:[text.slice(0,b.maxOutputBytes)],inputBytes:Buffer.byteLength(text)});
  };
  const flushLogs=()=>{
    if(omittedLines)send({type:'logOmission',lines:omittedLines,bytes:omittedBytes});
    if(lastError)send({type:'log',level:'error',parts:[lastError.text],inputBytes:lastError.size});
    omittedLines=0;omittedBytes=0;lastError=null;
  };
  const bare = {};
  const reserved = new Set(['tools','list_tools','tool_schema','attempt','stash','change','log','console','invoke','JSON','Math','String','Number','Boolean','Array','Object','Promise','Set','Map','Date','RegExp','Error']);
  for (const name of b.tools) if (!reserved.has(name) && /^[A-Za-z_$][\w$]*$/.test(name)) bare[name]=toolFns[name];
  for (const name of b.blocked ?? []) if (!reserved.has(name)) bare[name]=() => {
    const retired=b.retired?.[name];
    const p=Promise.reject(retired ? new Error(name+': '+retired) : new ReferenceError(name+' is not defined'));p.catch(()=>{});return p;
  };
  const sandbox={...bare,tools,list_tools:listTools,tool_schema:toolSchema,attempt,stash:localStash,
    log:(...parts)=>log('log',parts),console:{log:(...p)=>log('log',p),warn:(...p)=>log('warn',p),error:(...p)=>log('error',p)},
    invoke: request => rpc('structured', request.name, request.args),
    ...(b.changes.length ? {change:Object.fromEntries(b.changes.map(name=>[name,(...args)=>rpc('change',name,args)]))}:{}),
  };
  send({type:'ready'});
  heartbeat=setInterval(()=>{
    const usage=process.cpuUsage(previousCpu);previousCpu=process.cpuUsage();cpuMs+=(usage.user+usage.system)/1000;
    send({type:'heartbeat',cpuMs});
  },50);
  try {
    const result=await vm.runInNewContext(b.code,sandbox,{timeout:b.timeoutMs,filename:'code_exec.js',contextCodeGeneration:{strings:false,wasm:false}});
    flushLogs();send({type:'result',value:result});
  } catch(error) { flushLogs();send({type:'error',error:encode(error)}); }
}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
  try {
    if (Buffer.byteLength(line)>MAX_FRAME) throw new Error('code_exec IPC frame exceeds limit');
    const frame=JSON.parse(line);
    if (frame.type==='start' && !bootstrap) { void evaluate(frame.bootstrap).catch(error=>send({type:'error',error:encode(error)}));return; }
    if(frame.type==='response'){
      const item=pending.get(frame.id);if(!item)return;pending.delete(frame.id);
      frame.error ? item.reject(Object.assign(new Error(frame.error.message),frame.error)) : item.resolve(frame.value);
    }
  } catch(error) {send({type:'error',error:encode(error)});}
});
input.on('close',()=>process.exit(0));
`;
