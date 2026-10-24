import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { loadNativeHostBridge, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { NativeMcpStdioTransport } from '../NativeMcpStdioTransport.js';
import { nativeMcpStdioOptions } from '../native-mcp-stdio-factory.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each(['direct', 'cmd shim', 'lost ack'] as const)('runs MCP stdio with owned descendants: %s', async scenario => {
 const directory = await mkdtemp(join(tmpdir(), 'native-mcp-stdio-'));
 const script = join(directory, 'server.cjs'), proof = join(directory, 'effects.json');
 const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
  parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
 const binding = loadNativeHostBridge(runtime);
 if (!binding.startNativeHostDuplexProcess) throw Error('missing native stdio API');
 await writeFile(script, [
  'const fs=require("node:fs");const readline=require("node:readline");',
  'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",windowsHide:true});',
  'readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};',
  'if(m.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"stdio-fixture",version:"1"}};',
  'if(m.method==="tools/list")result={tools:[{name:"mutate",inputSchema:{type:"object"}}]};',
  'if(m.method==="tools/call"){fs.writeFileSync(' + JSON.stringify(proof) + ',JSON.stringify({root:process.pid,child:child.pid,args:process.argv.slice(2)}));',
  (scenario === 'lost ack' ? 'process.exit(1);' : 'result={content:[{type:"text",text:"confirmed"}]};') + '}',
  'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");});',
 ].join('\n'));
 const shim = join(directory, 'server shim.cmd');
 await writeFile(shim, '@echo off\r\n"' + process.execPath + '" "' + script + '" %*\r\n');
 const args = ['text with spaces', 'literal&argument', 'áéí'];
 const config: McpServerConfig = { id:'stdio',name:'stdio',transport:'stdio',enabled:true,
  command: scenario === 'cmd shim' ? shim : process.execPath,
  args: scenario === 'cmd shim' ? args : [script,...args], env:{},url:null,auth_type:'none',auth_token:null,
  config:{},default_tier:'core',created_at:'',updated_at:'' };
 const manager = new McpServerManager(null, async item => {
  const options = nativeMcpStdioOptions(item);
  return new NativeMcpStdioTransport(() => binding.startNativeHostDuplexProcess!(options));
 });
 let pids: {root:number;child:number;args:string[]} | undefined;
 try {
  await manager.connectServer(config);
  expect(manager.isStdioContained(config.id)).toBe(true);
  expect(manager.listStdioProcesses()).toHaveLength(1);
  const tool = (await manager.listAllTools()).tools[0]!;
  const result = await tool.handler({}, {cwd:directory,projectName:'stdio'});
  if(scenario === 'lost ack') expect(result.effectOutcome).toBe('unknown');
  else expect(result.content).toBe('confirmed');
  pids = JSON.parse(await readFile(proof,'utf8'));
  expect(pids!.args).toEqual(args);
  await manager.closeAll();
  for(const pid of [pids!.root,pids!.child]) expect(alive(pid)).toBe(false);
 } finally {
  await manager.closeAll();
  for(const pid of pids ? [pids.root,pids.child] : []) if(alive(pid)) process.kill(pid,'SIGKILL');
  if(dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('native-mcp-stdio-')) throw Error('unsafe fixture cleanup');
  await rm(directory,{recursive:true,force:true});
 }
},25_000);
function alive(pid:number) {try{process.kill(pid,0);return true;}catch{return false;}}
