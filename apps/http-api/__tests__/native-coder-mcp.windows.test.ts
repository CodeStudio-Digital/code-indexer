import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { MessageChannel } from 'node:worker_threads';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import type { McpServerConfig } from '@mcp/store/mcp-server-store.js';
import { loadNativeHostBridge, NativeSessionReader, parseRuntimePackageAnchor, verifyRuntimePackage } from '@mcp/agent-runtime-host';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { RemoteMcpServerManager } from '../workers/RemoteMcpServerManager.js';
import { McpServerManager } from '@mcp/code-agent/tools/mcp-server-manager.js';
import { NativeMcpStdioTransport } from '../sse/NativeMcpStdioTransport.js';
import { nativeMcpStdioOptions } from '../sse/native-mcp-stdio-factory.js';
import { McpExternalPool } from '../sse/McpExternalPool.js';
import { registerWorkerMcpCalls } from '../sse/worker-mcp-calls.js';
import { authorizeNativeMcpDispatch } from '../native-mcp-dispatch.js';
import { projectNativeSessionHistory } from '../native-session-history.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each((['streamable_http', 'sse', 'stdio'] as const).flatMap(transport =>
  (['success', 'lost-ack', 'changed-input', 'changed-shared-authority', 'worktree'] as const).map(scenario => ({ transport, scenario }))))('owns native MCP dispatch: $transport / $scenario', async ({ transport, scenario }) => {
  const product = await supervisorFactFixture('coder');
  const root = join(product.directory, 'project');
  let executionRoot = root;
  if (scenario === 'worktree') {
    const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe', timeout: 10_000 });
    git(['init', '--initial-branch=main']);
    await writeFile(join(root, 'fixture.txt'), 'fixture'); git(['add', '--', 'fixture.txt']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    executionRoot = join(root, '.mcp-indexer', 'worktrees', 'verified-worktree');
    git(['worktree', 'add', '--detach', executionRoot]);
  }
  const bus = createBus(new AbortController());
  const channel = new MessageChannel();
  const main = new MessageBridge({ port: channel.port1 }), worker = new MessageBridge({ port: channel.port2 });
  let mutations = 0, providerCalls = 0;
  let events: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    if (transport === 'sse' && request.method === 'GET') {
      events = response; response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202).end(); return; }
    let result: unknown = {};
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'native-mcp', version: '1' } };
    if (message.method === 'tools/list') result = { tools: [{ name: 'mutate', inputSchema: { type: 'object', properties: {} } }] };
    if (message.method === 'tools/call') {
      mutations++;
      if (scenario === 'lost-ack') { response.destroy(); return; }
      result = { content: [{ type: 'text', text: 'effect confirmed' }] };
    }
    const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    if (transport === 'sse') { response.writeHead(202).end(); events!.write('event: message\ndata: ' + reply + '\n\n'); }
    else response.writeHead(200, { 'content-type': 'application/json' }).end(reply);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address');
  const serverConfig: McpServerConfig = { id: 'fixture', name: 'fixture', transport, enabled: true,
    url: 'http://127.0.0.1:' + address.port + '/mcp', command: null, args: [], env: {}, auth_type: 'none', auth_token: null,
    default_tier: 'core', config: {}, created_at: '', updated_at: '' };
  const proof = join(product.directory, 'stdio-effect.json');
  const script = join(product.directory, 'stdio-server.cjs');
  let manager: McpServerManager | undefined;
  if (transport === 'stdio') {
    await writeFile(script, [
      'const fs=require("node:fs"),rl=require("node:readline");',
      'const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",windowsHide:true});',
      'let mutations=0;const save=()=>fs.writeFileSync('+JSON.stringify(proof)+',JSON.stringify({root:process.pid,child:child.pid,mutations}));save();',
      'rl.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};',
      'if(m.method==="initialize")result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"native-stdio",version:"1"}};',
      'if(m.method==="tools/list")result={tools:[{name:"mutate",inputSchema:{type:"object",properties:{}}}]};',
      'if(m.method==="tools/call"){mutations++;save();'+(scenario === 'lost-ack' ? 'process.exit(1);' : 'result={content:[{type:"text",text:"effect confirmed"}]};')+'}',
      'process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");});',
    ].join('\n'));
    serverConfig.command = process.execPath; serverConfig.args = [script]; serverConfig.url = null;
    const runtime = await verifyRuntimePackage(resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
      parseRuntimePackageAnchor(await readFile('dist/apps/electron/native-agent-runtime-integrity.json')));
    const binding = loadNativeHostBridge(runtime);
    manager = new McpServerManager(null, async item => {
      const options = nativeMcpStdioOptions(item);
      return new NativeMcpStdioTransport(() => binding.startNativeHostDuplexProcess!(options));
    });
  }
  const pool = new McpExternalPool({ dbPath: ':memory:', manager, loadEnabledServers: () => [serverConfig] });
  const config = { mode: 'test' as const, context: product.context,
    packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
    anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(product.directory, 'native-sessions'),
    workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases'),
    sharedWorkspaceLeaseRoot: join(product.directory, 'shared-workspace-leases') };
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context: product.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  main.handle('mcpExt.snapshot', () => pool.getReadySnapshot());
  const off = registerWorkerMcpCalls(main, () => pool, request => {
    expect(request.runId).toBe(1);
    if (scenario === 'changed-input') request.args = { changed: true };
    if (scenario === 'changed-shared-authority') {
      (request.authority as { payload: { sharedLease: { attemptId: string } } }).payload.sharedLease.attemptId = 'foreign';
    }
    return authorizeNativeMcpDispatch(request, config, product.store, () => {});
  });
  try {
    await pool.boot();
    const proxy = new RemoteMcpServerManager(worker, 1); await proxy.connectAll([]);
    const registry = new ToolRegistry(); registry.registerAll((await proxy.listAllTools()).tools); registry.seal();
    const systemPrompt = 'Run the admitted MCP capability once.';
    const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId, agentRunId: product.context.agentRunId,
      runnerRunId: 'native-mcp', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'),
      environment: { kind: scenario === 'worktree' ? 'worktree' : 'host', cwd: executionRoot },
      policy: { permissionMode: 'auto', planMode: false, specMode: false } }, registry);
    const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      if (++providerCalls === 1) {
        yield { type: 'tool_call_start', id: 'mutate-once', name: 'ext_fixture__mutate' };
        yield { type: 'tool_call_end', id: 'mutate-once', name: 'ext_fixture__mutate', input: {} };
      } else {
        expect(scenario).not.toBe('lost-ack');
        if (scenario === 'success') expect(JSON.stringify(request.messages)).toContain('effect confirmed');
        yield { type: 'text_delta', text: 'finished' };
      }
      yield { type: 'done' };
    } };
    const execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, config, assertOwner() {},
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Use the MCP fixture' }] }],
        toolContext: { cwd: executionRoot, projectName: 'native-mcp', signal: bus.ctrl.signal }, signal: bus.ctrl.signal } });
    await execution.done;
    if (transport === 'stdio') mutations = JSON.parse(await readFile(proof, 'utf8')).mutations;
    expect(mutations).toBe(scenario.startsWith('changed-') ? 0 : 1);
    expect(providerCalls).toBe(scenario === 'lost-ack' ? 1 : 2);
    const ledger = JSON.parse(await readFile(join(config.workspaceLeaseRoot, 'leases.json'), 'utf8'));
    expect(ledger.state.leases).toHaveLength(scenario === 'lost-ack' ? 1 : 0);
    const sharedLedger = JSON.parse(await readFile(join(config.sharedWorkspaceLeaseRoot, 'leases.json'), 'utf8'));
    expect(sharedLedger.state.leases).toHaveLength(scenario === 'lost-ack' ? 1 : 0);
    const runtime = await verifyRuntimePackage(config.packageDirectory, parseRuntimePackageAnchor(await readFile(config.anchorPath)));
    const reader = await NativeSessionReader.open(runtime, { rootPath: config.sessionRoot, sessionId: product.context.sessionId });
    try {
      const history = await projectNativeSessionHistory(reader, product.context.sessionId, new Date().toISOString());
      expect(JSON.stringify(history.messages).includes('"effect_outcome":"unknown"')).toBe(scenario === 'lost-ack');
    } finally { await reader.close(); }
  } finally {
    bus.ctrl.abort(); off(); main.dispose(); worker.dispose(); channel.port1.close(); channel.port2.close();
    await pool.shutdown();
    if (transport === 'stdio') {
      const pids = JSON.parse(await readFile(proof, 'utf8'));
      for (const pid of [pids.root, pids.child]) {
        let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
        expect(alive).toBe(false);
      }
    }
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
  }
}, 40_000);
