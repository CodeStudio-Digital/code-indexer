/**
 * A child-agent session of each profile gets the tool surface an in-process
 * child of that profile gets, over the same parent registry. Every
 * difference is listed here with its reason; a session without the relation
 * gets no child configuration at all.
 */
import { describe, expect, it } from 'vitest';
import type { CoderTool } from '../../core/tool.js';
import { fsTools } from '../../tools/fs.js';
import { shellTools } from '../../tools/shell.js';
import { execCommand, writeStdin } from '../../tools/exec-command.js';
import { applyPatchTool } from '../../tools/apply-patch.js';
import { gitTools } from '../../tools/git.js';
import { webTools } from '../../tools/web.js';
import { interactionTools } from '../../tools/interaction.js';
import { chatCollaborationTools } from '../../tools/chat-collaboration.js';
import { sessionNetworkTools } from '../../tools/session-network.js';
import { buildProjectMemoryTools } from '../../tools/project-memory-tools.js';
import { buildConversationChapterTools } from '../../tools/conversation-chapters.js';
import { buildSessionDriveTools } from '../../tools/session-drive-tools.js';
import { taskComplete, taskList } from '../../tools/tasks.js';
import { isChildToolAdmitted } from '../../tools/implement-subagent.js';
import { MICRO_AGENT_PROFILES, type MicroAgentProfileId } from '../../tools/micro-agent-profiles.js';
import { loadChildAgentRun } from '../child-agent-run.js';

const stub = (name: string, extra: Partial<CoderTool> = {}): CoderTool => ({
  name, source: 'native', description: name, parameters: { type: 'object', properties: {} },
  mutates: false, riskLevel: 'read', handler: async () => ({ content: '' }), ...extra,
});
// Registered after the in-process child snapshot (index.ts), so an
// in-process child never receives them whatever its allowlist says.
const AFTER_SNAPSHOT = ['self_review', 'create_skill', 'list_skill_namespaces', 'get_skills_list', 'get_skill_content', 'invoke_skill'];
const parentTools: CoderTool[] = [
  ...fsTools, ...shellTools, execCommand, writeStdin, applyPatchTool, ...gitTools, ...webTools, ...interactionTools,
  ...chatCollaborationTools, ...sessionNetworkTools, ...buildProjectMemoryTools(), ...buildConversationChapterTools(),
  ...buildSessionDriveTools(), taskComplete, taskList,
  stub('find_tools'), stub('code_exec', { riskLevel: 'execute' }), stub('request_review'), stub('mcp__grep_code'),
  stub('mcp__ext_read', { source: 'mcp_external' }), stub('mcp__ext_write', { source: 'mcp_external', mutates: true, riskLevel: 'write' }),
  ...AFTER_SNAPSHOT.map((name) => stub(name)),
];

function inProcessSurface(profile: MicroAgentProfileId): Set<string> {
  const admitted = parentTools.filter((tool) => !AFTER_SNAPSHOT.includes(tool.name) && isChildToolAdmitted(tool, MICRO_AGENT_PROFILES[profile].allowlist));
  // runSubagentTurn always adds record_memo and rebuilds find_tools over the child registry.
  return new Set([...admitted.map((tool) => tool.name), 'record_memo', 'find_tools']);
}

async function childSessionSurface(profile: string, readOnly = false): Promise<Set<string>> {
  const run = await loadChildAgentRun({ getChildAgentSession: async () => ({
    id: 'c' as never, parent_session_id: 'p' as never, depth: 1, status: 'idle', is_archived: false,
    updated_at: '', profile, read_only: readOnly, creation_fingerprint: 'f', created_at: '', conclusion: null }) }, 'c');
  return new Set(parentTools.filter((tool) => run!.allowsTool(tool)).map((tool) => tool.name));
}

const diff = (a: Set<string>, b: Set<string>) => [...a].filter((name) => !b.has(name)).sort();
const MEMORY = ['recall_conversation', 'recall_memory', 'remember'];
const SKILLS = ['get_skill_content', 'get_skills_list', 'invoke_skill', 'list_skill_namespaces'];

describe('child-agent session surface', () => {
  // added: native memory (in-process children have no project memory or
  // drive; an in-process full child already inherits it); skill tools the
  // explore/verify/implement allowlists name and full admits (in-process
  // children lost them only to registration order).
  // removed: record_memo (it speaks to an in-process collector; a session
  // answers with its final answer and chat messages).
  it.each([
    ['explore', [...MEMORY, ...SKILLS].sort()],
    ['implement', [...MEMORY, ...SKILLS].sort()],
    ['verify', [...MEMORY, ...SKILLS].sort()],
    ['review', MEMORY],
    ['full', SKILLS],
  ] as const)('%s: same tools as an in-process child except the listed ones', async (profile, added) => {
    const session = await childSessionSurface(profile);
    const inProcess = inProcessSurface(profile);
    expect(diff(session, inProcess)).toEqual(added);
    expect(diff(inProcess, session)).toEqual(['record_memo']);
  });

  it('never delegates, interacts with the user, reviews itself or authors skills', async () => {
    for (const profile of Object.keys(MICRO_AGENT_PROFILES)) {
      const session = await childSessionSurface(profile);
      for (const name of ['spawn_agent', 'create_chat', 'create_chat_trigger', 'request_review', 'self_review',
        'create_skill', 'task_complete', 'ask_user', 'decision_gate', 'task_list']) expect(session.has(name)).toBe(false);
    }
  });

  it('a read-only child neither writes nor runs commands, whatever profile was recorded', async () => {
    const session = await childSessionSurface('implement', true);
    for (const name of ['write_file', 'edit_file', 'apply_patch', 'run_command', 'exec_command', 'write_stdin', 'code_exec', 'mcp__ext_write']) {
      expect(session.has(name)).toBe(false);
    }
    expect(session.has('read_file')).toBe(true);
    expect(session.has('recall_memory')).toBe(true);
  });

  it('gives no configuration to a session without the child-agent relation', async () => {
    expect(await loadChildAgentRun({ getChildAgentSession: async () => null }, 'plain')).toBeNull();
  });
});
