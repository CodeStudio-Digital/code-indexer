import { createHash } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { fsTools } from '@mcp/code-agent/tools/fs.js';
import { viewImage } from '@mcp/code-agent/tools/view-image.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { NativeSessionReader, verifyRuntimePackage, parseRuntimePackageAnchor } from '@mcp/agent-runtime-host';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { projectNativeSessionHistory } from '../native-session-history.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt('delivers a real tool image to the provider, live preview and durable history', async () => {
  const product = await supervisorFactFixture('coder');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  const bus = createBus(new AbortController());
  const root = join(product.directory, 'project');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=';
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: product.store, context: product.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  try {
    await writeFile(join(root, 'image.png'), Buffer.from(png, 'base64'));
    await writeFile(join(root, 'text.txt'), 'parallel text');
    const registry = new ToolRegistry();
    registry.register(viewImage);
    registry.register(fsTools.find(tool => tool.name === 'read_file')!);
    registry.seal();
    const systemPrompt = 'Read the image and text, then describe them.';
    const preparation = prepareCoderAttempt({ sessionId: product.context.sessionId, agentRunId: product.context.agentRunId,
      runnerRunId: 'native-image', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder', capabilityProfile: 'full',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), environment: { kind: 'host', cwd: root },
      policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    let calls = 0;
    const provider: ChatProvider = { name: 'openai', model: 'fixture', setModel() {}, async *chat(request) {
      if (++calls === 1) {
        for (const tool of [{ id: 'image', name: 'view_image', input: { path: 'image.png' } },
          { id: 'text', name: 'read_file', input: { path: 'text.txt' } }]) {
          yield { type: 'tool_call_start', id: tool.id, name: tool.name };
          yield { type: 'tool_call_end', ...tool };
        }
      } else {
        expect(request.messages.at(-1)?.content).toEqual([{ type: 'image', mediaType: 'image/png', base64: png }]);
        expect(request.messages.slice(-3, -1).map(message => message.role)).toEqual(['tool', 'tool']);
        expect(JSON.stringify(request.messages)).toContain('parallel text');
        yield { type: 'text_delta', text: 'Image observed' };
      }
      yield { type: 'done' };
    } };
    const packageDirectory = resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc');
    const anchorPath = resolve('dist/apps/electron/native-agent-runtime-integrity.json');
    const sessionRoot = join(product.directory, 'native-sessions');
    const execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: product.context, packageDirectory, anchorPath, sessionRoot,
        workspaceRoot: root, workspaceLeaseRoot: join(product.directory, 'native-workspace-leases') },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the image and text' }] }],
        toolContext: { cwd: root, projectName: 'native-image', signal: bus.ctrl.signal }, signal: bus.ctrl.signal } });
    await execution.done;
    expect(calls).toBe(2);
    expect(bus.buffer.find(event => event.event === 'tool_call_result' && (event.data as { name: string }).name === 'view_image')?.data)
      .toMatchObject({ result: { image: { mediaType: 'image/png', base64: png } } });
    await rm(join(root, 'image.png'));
    const runtimePackage = await verifyRuntimePackage(packageDirectory, parseRuntimePackageAnchor(await readFile(anchorPath)));
    const reader = await NativeSessionReader.open(runtimePackage, { rootPath: sessionRoot, sessionId: product.context.sessionId });
    try {
      const history = await projectNativeSessionHistory(reader, product.context.sessionId, new Date().toISOString());
      expect(history.messages.flatMap(message => message.content).filter(block => block.type === 'image'))
        .toEqual([{ type: 'image', mediaType: 'image/png', base64: png }]);
      expect(history.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Image observed' }]);
    } finally { await reader.close(); }
  } finally {
    bus.ctrl.abort(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
  }
}, 40_000);
