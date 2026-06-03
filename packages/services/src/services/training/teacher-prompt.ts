/**
 * Teacher prompt builder — pure string assembly (no network). Produces the
 * system + user messages that ask the teacher provider to distill ONE
 * instruction/input/output example from a real seed, grounded on RAG snippets.
 *
 * The orchestrator (`dataset-job`) performs the RAG retrieval and passes the
 * grounding snippets in, keeping this module side-effect free and testable.
 */
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { StackProfile } from './stack-profiles.js';
import type { Seed } from './types.js';

const JSON_CONTRACT =
  'Respond with ONLY a JSON object, no prose, no code fences, of the exact ' +
  'shape: {"instruction": string, "input": string, "output": string}. ' +
  '"instruction" is a realistic task a developer would ask. "input" is any ' +
  'extra constraints (may be empty string). "output" is the ideal, complete, ' +
  'compilable solution code for that task.';

export function buildSystem(profile: StackProfile): string {
  return `${profile.promptFraming}\n\n${JSON_CONTRACT}`;
}

export function buildTeacherMessages(
  profile: StackProfile,
  seed: Seed,
  grounding: string[],
): { system: string; messages: AgentMessage[] } {
  const groundingBlock = grounding.length
    ? `\n\nProject/docs reference (follow these conventions):\n${grounding
        .map((g, i) => `--- snippet ${i + 1} ---\n${g}`)
        .join('\n')}`
    : '';

  const seedLabel = seed.source === 'shadcn-block' ? 'shadcn block' : 'project file';
  const user =
    `Here is a real ${seedLabel} (\`${seed.filePath}\`) from the codebase. ` +
    `Using it and the references as the style guide, invent ONE realistic ` +
    `task in the same stack and produce the ideal solution.\n\n` +
    `\`\`\`\n${seed.body}\n\`\`\`${groundingBlock}`;

  return {
    system: buildSystem(profile),
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  };
}
