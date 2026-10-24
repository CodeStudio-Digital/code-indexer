import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Local controlled stdio server; records every root and detached descendant. */
export async function startMcpStdioFixture(projectRoot) {
  const script = join(projectRoot, 'harness-mcp-server.cjs');
  const statsPath = join(projectRoot, 'mcp-stats.json');
  const pidsPath = join(projectRoot, 'mcp-pids.jsonl');
  const effect = join(projectRoot, 'mcp-effect.txt');
  await writeFile(statsPath, JSON.stringify({ mutations: 0, discoveries: 0 }));
  await writeFile(pidsPath, '');
  await writeFile(script, [
    'const fs=require("node:fs"),rl=require("node:readline");',
    'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",windowsHide:true});',
    'fs.appendFileSync('+JSON.stringify(pidsPath)+',JSON.stringify({root:process.pid,child:child.pid})+"\\n");',
    'const statsFile='+JSON.stringify(statsPath)+';const stats=JSON.parse(fs.readFileSync(statsFile,"utf8"));const save=()=>fs.writeFileSync(statsFile,JSON.stringify(stats));',
    'rl.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};',
    'if(m.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"stdio-lost-ack",version:"1"}};',
    'if(m.method==="tools/list"){stats.discoveries++;save();result={tools:[{name:"mutate",description:"HARNESS_MCP_CASE fixture mutation.",inputSchema:{type:"object",properties:{}}}]};}',
    'if(m.method==="tools/call"){stats.mutations++;save();fs.writeFileSync('+JSON.stringify(effect)+',"effects:"+stats.mutations);process.exit(1);}',
    'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");});',
  ].join('\n'));
  return {
    configuration: { transport: 'stdio', command: process.execPath, args: [script], env: {} },
    get stats() { return JSON.parse(readFileSync(statsPath, 'utf8')); },
    async assertSingleEffect() { assert.equal(await readFile(effect, 'utf8'), 'effects:1'); },
    async close() {
      const pids = (await readFile(pidsPath, 'utf8')).trim().split('\n').filter(Boolean)
        .flatMap(line => { const item = JSON.parse(line); return [item.root, item.child]; });
      const alive = () => pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      for (let check = 0; check < 20 && alive().length; check++) await new Promise(r => setTimeout(r, 100));
      const remaining = alive();
      // Fixture PIDs only. A failed assertion still leaves no test descendants behind.
      for (const pid of remaining) process.kill(pid, 'SIGKILL');
      assert.deepEqual(remaining, [], 'MCP stdio processes survived shutdown');
      return { trackedProcesses: pids, stillAlive: remaining };
    },
  };
}
