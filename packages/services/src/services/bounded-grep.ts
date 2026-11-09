import { Worker } from 'node:worker_threads';

export interface TextMatch { file: string; line: number; text: string; start: number; end: number }
export interface GrepEvidence {
  matches: TextMatch[];
  examinedFiles: number;
  skippedFiles: number;
  skippedLines: number;
  changedFiles: number;
  truncated: boolean;
}
export interface GrepSource { rootPath: string; prefix: string }

// Embedded source works identically from TS, bundles and ASAR. Arbitrary regex
// runs off the application event loop; terminating this worker cancels it even
// when the regex engine is stuck inside one expression.
const SOURCE = String.raw`
const {parentPort,workerData:d}=require('node:worker_threads');
const fs=require('node:fs'), path=require('node:path');
const re=new RegExp(d.pattern,d.flags.replace(/[gy]/g,'')+'g');
const result={matches:[],examinedFiles:0,skippedFiles:0,skippedLines:0,changedFiles:0,truncated:false};
const roots=d.sources.map(s=>({...s,real:fs.realpathSync(s.rootPath)}));
for(const file of d.paths){
  if(result.matches.length>=d.maxMatches){result.truncated=true;break;}
  try {
    const source=roots.find(s=>!s.prefix||file.startsWith(s.prefix+'/'));
    if(!source)throw new Error('outside declared roots');
    const rel=source.prefix?file.slice(source.prefix.length+1):file;
    const absolute=fs.realpathSync(path.resolve(source.rootPath,rel));
    const check=path.relative(source.real,absolute);
    if(!check||check==='..'||check.startsWith('..'+path.sep)||path.isAbsolute(check))throw new Error('outside root');
    const before=fs.statSync(absolute);
    if(!before.isFile()||before.size>d.maxFileBytes){result.skippedFiles++;continue;}
    const content=fs.readFileSync(absolute,'utf8');
    const after=fs.statSync(absolute);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)result.changedFiles++;
    if(content.includes('\0')){result.skippedFiles++;continue;}
    result.examinedFiles++;
    const lines=content.split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      const text=lines[i];
      if(text.length>d.maxLineLen){result.skippedLines++;continue;}
      re.lastIndex=0;
      let match;
      while((match=re.exec(text))!==null){
        result.matches.push({file,line:i+1,text,start:match.index,end:match.index+match[0].length});
        if(result.matches.length>=d.maxMatches){result.truncated=true;break;}
        if(d.onePerLine)break;
        if(!match[0].length)re.lastIndex++;
      }
      if(result.truncated)break;
    }
  }catch{result.skippedFiles++;}
}
parentPort.postMessage(result);
`;

let active = 0;
const waiting: Array<() => void> = [];
async function acquire(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (active >= 2) await new Promise<void>((resolve, reject) => {
    const wake = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { const i = waiting.indexOf(wake); if (i >= 0) waiting.splice(i, 1); reject(signal!.reason); };
    waiting.push(wake);
    signal?.addEventListener('abort', abort, { once: true });
  });
  else active++;
  return () => { const next = waiting.shift(); if (next) next(); else active--; };
}

export async function boundedGrep(input: {
  sources: GrepSource[]; paths: string[]; pattern: RegExp;
  maxMatches: number; maxLineLen?: number; onePerLine?: boolean;
  signal?: AbortSignal; timeoutMs?: number;
}): Promise<GrepEvidence> {
  const release = await acquire(input.signal);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    input.signal?.throwIfAborted();
    worker = new Worker(SOURCE, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 }, workerData: {
      sources: input.sources, paths: input.paths, pattern: input.pattern.source, flags: input.pattern.flags,
      maxMatches: Math.max(1, Math.min(5000, Math.floor(input.maxMatches) || 1000)),
      maxLineLen: Math.max(100, Math.min(10_000, input.maxLineLen ?? 2000)), maxFileBytes: 1024 * 1024,
      onePerLine: input.onePerLine,
    } });
    return await new Promise<GrepEvidence>((resolve, reject) => {
      worker!.once('message', resolve);
      worker!.once('error', reject);
      worker!.once('exit', code => { if (code !== 0) reject(new Error(`Grep worker exited (${code})`)); });
      abort = () => reject(input.signal!.reason ?? new Error('Search cancelled'));
      input.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new Error('Search deadline exceeded; narrow the pattern or scope')), input.timeoutMs ?? 10_000);
      timer.unref();
      if (input.signal?.aborted) abort();
    });
  } finally {
    clearTimeout(timer);
    if (abort) input.signal?.removeEventListener('abort', abort);
    await worker?.terminate();
    release();
  }
}
