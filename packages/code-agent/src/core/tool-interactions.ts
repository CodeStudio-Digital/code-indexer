import type { ToolContext } from './tool.js';
import type { InteractiveToolPort } from '../ports/interactive-tool-port.js';

const legacyPorts = new WeakMap<object, InteractiveToolPort>();

/** Compatibility adapter for existing tools; native attempts supply the port
 * directly and never create a legacy runner. */
export function toolInteractions(context: ToolContext): InteractiveToolPort | undefined {
  if (context.ports?.interactions) return context.ports.interactions;
  const runner = context.runner;
  if (!runner) return undefined;
  let port = legacyPorts.get(runner);
  if (!port) {
    port = {
      get agentId() { return runner.agentId; }, get specMode() { return runner.specMode; },
      approvePlan: () => runner.approvePlan(),
      approveSpec: path => runner.approveSpec(path),
      request(review) {
        const response = runner.waitForUserInput(review.kind === 'budget_request' ? review.payload.ask_id : undefined);
        if (review.kind === 'question') runner.emit('question_posted', review.payload);
        else if (review.kind === 'decision') runner.emit('decision_posted', review.payload);
        else if (review.kind === 'tasks_posted') runner.emit('tasks_posted', review.payload);
        else if (review.kind === 'spec') runner.emit('spec_posted', review.payload);
        else if (review.kind === 'budget_request') runner.emit('budget_request', review.payload);
        else runner.emit('plan_posted', review.payload);
        return response;
      },
    };
    legacyPorts.set(runner, port);
  }
  return port;
}
