/**
 * The rules deciding whether a pid may be terminated from the task manager.
 *
 * This is the safety boundary of the whole feature. Without rule 4 the kill
 * endpoint would be a general-purpose `taskkill` against anything on the
 * machine, reachable from the renderer — so the guard is a small pure module
 * with its own tests rather than an `if` buried in a route handler.
 *
 * The verdict is computed once per snapshot and shipped to the UI as
 * `killable`/`killReason`, so the button state and the endpoint can never
 * disagree about what is allowed.
 */

type KillDenyCode =
  | 'invalid_pid'
  | 'main_process_protected'
  | 'caller_renderer_protected'
  | 'not_a_descendant'
  | 'worker_thread';

export interface KillContext {
  /** The backend's own pid — killing it takes the whole app down. */
  mainPid: number;
  /** Pids in the app's process tree, including adopted orphans. */
  descendants: ReadonlySet<number>;
  /** pid → Electron process type, for the `Browser` (main) check. */
  electronTypeByPid: ReadonlyMap<number, string>;
  /** Renderer pids hosting the dashboard UI itself. */
  dashboardPids: ReadonlySet<number>;
}

type KillVerdict =
  | { ok: true }
  | { ok: false; code: KillDenyCode; status: 400 | 403 };

const ALLOWED: KillVerdict = { ok: true };

/**
 * Evaluate a kill request.
 *
 * Note on the dashboard rule: the backend runs in-process and serves the
 * renderer through `httpRouter.fetch`, so there is no per-renderer identity on
 * the request to check against. The guard therefore works off the window
 * label Electron gives us — preview and popout windows stay killable, the
 * dashboard itself never is. That is the correct outcome, just arrived at by
 * labelling rather than by authenticating the caller.
 */
export function evaluateKill(pid: number, ctx: KillContext): KillVerdict {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, code: 'invalid_pid', status: 400 };
  }
  if (pid === ctx.mainPid) {
    return { ok: false, code: 'main_process_protected', status: 403 };
  }
  if (ctx.electronTypeByPid.get(pid)?.toLowerCase() === 'browser') {
    return { ok: false, code: 'main_process_protected', status: 403 };
  }
  if (ctx.dashboardPids.has(pid)) {
    return { ok: false, code: 'caller_renderer_protected', status: 403 };
  }
  // The load-bearing rule: only processes the app actually owns.
  if (!ctx.descendants.has(pid)) {
    return { ok: false, code: 'not_a_descendant', status: 403 };
  }
  return ALLOWED;
}
