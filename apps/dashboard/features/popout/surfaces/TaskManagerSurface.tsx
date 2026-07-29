/**
 * Detachable surface for the task manager (route /popout/task-manager).
 *
 * Takes no params — the panel always shows the whole app process tree, the
 * same way Chrome's task manager is a single global window. Lazy-loaded by the
 * registry so importing the registry does not pull the panel's chunk.
 */
import TaskManagerPanel from '../../task-manager/TaskManagerPanel.js';

export default function TaskManagerSurface() {
  return <TaskManagerPanel />;
}
