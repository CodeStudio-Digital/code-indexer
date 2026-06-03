/**
 * Eval-harness — turns "did Phase A pay off?" into a number. Runs a candidate
 * model over the held-out tasks and measures how many of its solutions pass
 * the SAME profile validator used during dataset construction.
 *
 * Compare two runs to get the real gain: `evalHoldout(baseProvider)` →
 * baseline pass-rate, `evalHoldout(trainedProvider)` → trained pass-rate.
 * Gain = trained − baseline. The caller (Phase B/C) supplies the providers.
 */
import { readFile } from 'node:fs/promises';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import type { StackProfile } from './stack-profiles.js';
import { validateOutput } from './validator.js';
import type { EvalResult, ValidationResult } from './types.js';

export interface EvalDeps {
  shell: IShellPort;
  dataDir: string;
  visualGate?: (sandboxDir: string) => Promise<ValidationResult>;
}

interface HoldoutTask { prompt: string }

function parseHoldout(raw: string): HoldoutTask[] {
  const tasks: HoldoutTask[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { messages: { role: string; content: string }[] };
      const user = obj.messages.find((m) => m.role === 'user');
      if (user) tasks.push({ prompt: user.content });
    } catch {
      // skip malformed line
    }
  }
  return tasks;
}

/** Extract code from a model reply — prefer a fenced block, else the whole text. */
function extractCode(text: string): string {
  const fence = text.match(/```(?:[\w-]+)?\s*([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

async function complete(provider: ChatProvider, profile: StackProfile, prompt: string, signal?: AbortSignal): Promise<string> {
  let text = '';
  const system = `${profile.promptFraming}\n\nOutput ONLY the solution code.`;
  for await (const d of provider.chat({
    system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], signal,
  })) {
    if (d.type === 'text_delta') text += d.text;
  }
  return extractCode(text);
}

export async function evalHoldout(
  provider: ChatProvider,
  holdoutPath: string,
  profile: StackProfile,
  deps: EvalDeps,
  signal?: AbortSignal,
): Promise<EvalResult> {
  let raw = '';
  try {
    raw = await readFile(holdoutPath, 'utf-8');
  } catch {
    return { total: 0, passed: 0, passRate: 0 };
  }
  const tasks = parseHoldout(raw);

  let passed = 0;
  for (const task of tasks) {
    if (signal?.aborted) break;
    let code = '';
    try {
      code = await complete(provider, profile, task.prompt, signal);
    } catch {
      continue; // generation error counts as a miss
    }
    const result = await validateOutput(
      profile, code, { shell: deps.shell, dataDir: deps.dataDir, visualGate: deps.visualGate }, signal,
    );
    if (result.verdict === 'pass') passed++;
  }

  const total = tasks.length;
  return { total, passed, passRate: total > 0 ? passed / total : 0 };
}
