import { createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { MessageBridge } from '@mcp/orchestrator-host';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { buildSkillDiscoveryTools, buildInvokeSkillTool } from '@mcp/code-agent/skills/skill-tool-builder.js';
import type { ResolvedSkill } from '@mcp/code-agent/skills/types.js';
import { prepareCoderAttempt } from '@mcp/code-agent/runtime/attempt-preparation.js';
import { prepareSelectedSkillContext } from '@mcp/code-agent/runtime/prepared-skill-context.js';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import { executeNativeCoder } from '../workers/native-coder-execution.js';
import { dispatchNativeAuthority, type NativeAuthorityOperation } from '../workers/native-authority-bridge.js';
import { nativeCoderWorkspaceAccess } from '../workers/native-coder-catalog.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { installNativeSessionHistory } from '../native-session-history.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt('loads real skill instructions through the native sealed catalog and preserves their tool results', async () => {
  const f = await supervisorFactFixture('coder');
  const ports = new MessageChannel();
  const main = new MessageBridge({ port: ports.port1 });
  const worker = new MessageBridge({ port: ports.port2 });
  const bus = createBus(new AbortController());
  const closeHistory = installNativeSessionHistory(f.sessions, f.directory);
  const root = join(f.directory, 'project');
  const skill: ResolvedSkill = { id: 'fixture:review', name: 'Review', description: 'Review the current project', slashCommand: '/review',
    promptBody: 'SKILL_PROOF: inspect ${PROJECT_NAME} before editing.', allowedTools: ['read_file'],
    modelOverride: null, providerOverride: null, contextMode: 'both', pathPatterns: null,
    triggerPaths: null, triggerRoles: null, triggerTags: null, tags: [], source: 'user', author: null, sortOrder: 0 };
  const template = { PROJECT_NAME: 'native-skills', PROJECT_ROOT: root, SESSION_ID: f.context.sessionId,
    OS: process.platform, TIMESTAMP: new Date().toISOString() };
  main.handle('native.authority', payload => dispatchNativeAuthority({ authority: f.store, context: f.context,
    operation: (payload as { operation: NativeAuthorityOperation }).operation, assertOwner() {} }));
  let execution: Awaited<ReturnType<typeof executeNativeCoder>> | undefined;
  try {
    const registry = new ToolRegistry();
    registry.registerAll(buildSkillDiscoveryTools([skill], template, f.sessions, f.context.sessionId));
    registry.register(buildInvokeSkillTool([skill], template, f.context.sessionId, f.sessions));
    registry.seal();
    expect(nativeCoderWorkspaceAccess(registry.list())).toBe('read_only');
    const systemPrompt = 'Use the selected skill without switching provider or model.';
    const preparation = prepareCoderAttempt({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId,
      runnerRunId: 'native-skills', provider: 'openai', model: 'fixture', agentDefinitionId: 'coder',
      systemPromptSha256: createHash('sha256').update(systemPrompt).digest('hex'), capabilityProfile: 'full',
      environment: { kind: 'host', cwd: root }, policy: { permissionMode: 'ask', planMode: false, specMode: false } }, registry);
    let calls = 0;
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Load fixture:review.' }], selectedSkillIds: [skill.id] }];
    const preparedUserContext = prepareSelectedSkillContext({ messages, template,
      getSkill: () => ({ id: skill.id, name: skill.name, prompt_body: 'SELECTED_SKILL: use ${PROJECT_NAME}.' }) });
    const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      calls++;
      expect(JSON.stringify(request.messages[0])).toContain('SELECTED_SKILL: use native-skills.');
      expect(request.system).not.toContain('SELECTED_SKILL');
      if (calls === 1) {
        for (const [id, name, input] of [
          ['namespace', 'list_skill_namespaces', {}], ['list', 'get_skills_list', {}],
          ['content', 'get_skill_content', { skill_id: skill.id }], ['invoke', 'invoke_skill', { skill_id: skill.id }],
        ] as const) {
          yield { type: 'tool_call_start', id, name };
          yield { type: 'tool_call_end', id, name, input };
        }
      } else {
        expect(calls).toBe(2);
        const results = request.messages.filter(message => message.role === 'tool');
        expect(results).toHaveLength(4);
        expect(JSON.stringify(results)).toContain('SKILL_PROOF: inspect native-skills before editing.');
        const history = await closeHistory.readLive(f.context.sessionId);
        expect(history?.messages.filter(message => message.role === 'tool')).toHaveLength(4);
        expect(JSON.stringify(history?.messages)).toContain('SKILL_PROOF');
        expect(history?.messages[0]?.selectedSkillIds).toEqual([skill.id]);
        expect(history?.messages[0]?.content).toEqual(messages[0]!.content);
        expect(history?.rows[0]?.selected_skill_ids_json).toBe(JSON.stringify([skill.id]));
        yield { type: 'text_delta', text: 'Skill loaded in Rust attempt.' };
      }
      yield { type: 'done' };
    } };
    execution = await executeNativeCoder({ bridge: worker, runId: 1, bus, assertOwner() {},
      config: { mode: 'test', context: f.context, packageDirectory: resolve('dist/native-agent-runtime/x86_64-pc-windows-msvc'),
        anchorPath: resolve('dist/apps/electron/native-agent-runtime-integrity.json'), sessionRoot: join(f.directory, 'native-sessions'),
        workspaceRoot: root, workspaceLeaseRoot: join(f.directory, 'native-workspace-leases') },
      prepared: { preparation, registry, provider, systemPrompt, thinking: false, maxTurns: 3,
        messages, preparedUserContext,
        toolContext: { cwd: root, projectName: 'native-skills', signal: bus.ctrl.signal } } });
    await execution.done;
    expect(calls).toBe(2);
    expect(bus.buffer.some(row => row.event === 'tool_approval')).toBe(false);
    expect(await f.store.getRuntimeRoute(f.context.sessionId, f.context.attemptId)).toMatchObject({ runtimeGeneration: 'rust_v1' });
  } finally {
    bus.ctrl.abort();
    await execution?.done.catch(() => undefined);
    await closeHistory(); main.dispose(); worker.dispose(); ports.port1.close(); ports.port2.close();
    await f.sessions.close(); await rm(f.directory, { recursive: true, force: true });
  }
}, 40_000);
