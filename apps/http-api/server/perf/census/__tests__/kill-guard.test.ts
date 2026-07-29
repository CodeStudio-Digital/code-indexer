import { describe, it, expect } from 'vitest';
import { evaluateKill, type KillContext } from '../kill-guard.js';

function ctx(over: Partial<KillContext> = {}): KillContext {
  return {
    mainPid: 100,
    descendants: new Set([100, 200, 300, 400]),
    electronTypeByPid: new Map([[100, 'Browser'], [300, 'Tab'], [400, 'GPU']]),
    dashboardPids: new Set([300]),
    ...over,
  };
}

describe('evaluateKill', () => {
  it('allows a process the app owns', () => {
    expect(evaluateKill(200, ctx())).toEqual({ ok: true });
  });

  it('allows killing a GPU or preview renderer', () => {
    expect(evaluateKill(400, ctx())).toEqual({ ok: true });
  });

  it('rejects a malformed pid with 400', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateKill(pid, ctx())).toEqual({
        ok: false, code: 'invalid_pid', status: 400,
      });
    }
  });

  it('protects the backend process by pid', () => {
    expect(evaluateKill(100, ctx())).toEqual({
      ok: false, code: 'main_process_protected', status: 403,
    });
  });

  it('protects the Electron browser process even if its pid is not mainPid', () => {
    // Out-of-process backend: the app's `Browser` process is not our own pid.
    const detached = ctx({
      mainPid: 999,
      descendants: new Set([100, 999]),
    });
    expect(evaluateKill(100, detached)).toEqual({
      ok: false, code: 'main_process_protected', status: 403,
    });
  });

  it('protects the renderer hosting the dashboard', () => {
    expect(evaluateKill(300, ctx())).toEqual({
      ok: false, code: 'caller_renderer_protected', status: 403,
    });
  });

  it('refuses any pid outside the app process tree', () => {
    // The rule that stops this endpoint from being a general-purpose taskkill.
    expect(evaluateKill(4242, ctx())).toEqual({
      ok: false, code: 'not_a_descendant', status: 403,
    });
  });

  it('checks protections before ownership, so a foreign main is still 403-main', () => {
    const noTree = ctx({ descendants: new Set() });
    expect(evaluateKill(100, noTree)).toMatchObject({ code: 'main_process_protected' });
    expect(evaluateKill(300, noTree)).toMatchObject({ code: 'caller_renderer_protected' });
  });
});
