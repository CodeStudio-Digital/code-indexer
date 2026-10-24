interface AgentCliInteractionIO {
  write(text: string): void;
  prompt(question: string): Promise<string>;
  respond(path: string, body: unknown): Promise<void>;
}
type Option = { label: string; value: string; summary?: string; tradeoffs?: string };
const approve = (text: string) => ['y', 'yes'].includes(text.trim().toLowerCase());

/** The CLI uses the same interaction endpoints and durable keyed approvals as
 * the dashboard. No command is released through a direct runner reference. */
export async function handleAgentInteraction(event: string, data: Record<string, unknown>, io: AgentCliInteractionIO): Promise<boolean> {
  if (event === 'tool_approval_request') {
    io.write(`\n\n⚠ ${data.toolName} (${data.riskClass})\n${data.argsSummary}\n`);
    await io.respond('tool-approval', { tool_use_id: data.toolUseId,
      approved: approve(await io.prompt('Allow this tool call? [y/N] ')) });
  } else if (event === 'plan') {
    io.write(`\n\n📋 PLAN:\n${data.plan}\n\n`);
    await io.respond('plan-response', { approved: approve(await io.prompt('Approve plan? [y/N] ')), interaction_id: data.id });
  } else if (event === 'spec') {
    io.write(`\n\n📋 SPEC:\n${data.summary ?? data.spec_path ?? JSON.stringify(data)}\n\n`);
    await io.respond('spec-response', { approved: approve(await io.prompt('Approve specification? [y/N] ')), spec_path: data.spec_path });
  } else if (event === 'question') {
    const options = (data.options ?? []) as Option[];
    io.write(`\n\n❓ ${data.question}\n`);
    options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}\n`));
    let answer = (await io.prompt('> ')).trim();
    const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
    if (options[index]) answer = options[index]!.value;
    await io.respond('answer', { answer, interaction_id: data.id });
  } else if (event === 'decision') {
    const answers: Record<string, { selected?: string[]; freeform?: string }> = {};
    for (const question of data.questions as Array<{ id: string; question: string; multiSelect?: boolean; options: Option[] }>) {
      io.write(`\n\n❓ ${question.question}\n`);
      question.options.forEach((option, index) => io.write(`  ${index + 1}. ${option.label}${option.summary ? ` — ${option.summary}` : ''}\n`));
      const answer = (await io.prompt(question.multiSelect ? '> (numbers separated by commas, or text) ' : '> ')).trim();
      const indices = answer.split(',').map(part => /^\d+$/.test(part.trim()) ? Number(part.trim()) - 1 : -1);
      answers[question.id] = indices.every(index => Boolean(question.options[index])) && (question.multiSelect || indices.length === 1)
        ? { selected: [...new Set(indices.map(index => question.options[index]!.value))] } : { freeform: answer };
    }
    await io.respond('decide', { answers, interaction_id: data.id });
  } else if (event === 'tasks_posted') {
    const tasks = data.tasks as Array<{ id: string; title: string; suggested_mode: string; estimated_complexity: string; depends_on: string[]; files: string[] }>;
    io.write(`\n\n📋 TASKS (${tasks.length}): ${data.summary}\n`);
    for (const task of tasks) {
      const deps = task.depends_on.length ? ` (after: ${task.depends_on.join(', ')})` : '';
      io.write(`  - ${task.id} [${task.suggested_mode}/${task.estimated_complexity}]${deps}: ${task.title}\n      files: ${task.files.join(', ') || '(none)'}\n`);
    }
    const approved = approve(await io.prompt('\nApprove tasks? [y/N] '));
    const mode = approved ? (await io.prompt('Execution mode? [i=inline | s=all-subagent | m=smart] (default i) ')).trim().toLowerCase() : '';
    const execution_mode = ['s', 'subagent', 'all-subagent'].includes(mode) ? 'all-subagent'
      : ['m', 'smart'].includes(mode) ? 'smart' : 'inline';
    await io.respond('tasks-response', { approved, execution_mode });
  } else return false;
  return true;
}
