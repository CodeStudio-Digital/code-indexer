import { describe, expect, it, vi } from 'vitest';
import {
  disposeCompanyStreamLifecycle,
  resolveCompanyStreamTransport,
} from '../useCompanyStream.js';

describe('resolveCompanyStreamTransport', () => {
  it('routes the App surface exclusively through its App-owned facade', () => {
    expect(resolveCompanyStreamTransport(90, { kind: 'app_studio', appSessionId: 7 })).toEqual({
      basePath: '/api/app-studio/apps/7/team/commands',
      statePath: '/state',
      includeKanban: false,
      allowDirectAgentControls: false,
      allowRuntimeSwitch: false,
      keepAttachedWhileOrchestratorLive: true,
    });
  });

  it('preserves the generic Company transport for Company mode', () => {
    expect(resolveCompanyStreamTransport(90)).toEqual({
      basePath: '/api/company/sessions/90',
      statePath: '',
      includeKanban: true,
      allowDirectAgentControls: true,
      allowRuntimeSwitch: true,
      keepAttachedWhileOrchestratorLive: false,
    });
  });

  it('invalidates and aborts an App stream when its rail unmounts', () => {
    const abort = vi.fn();
    const lifecycle = { current: 4 };
    const controller: { current: AbortController | null } = {
      current: { abort } as unknown as AbortController,
    };

    disposeCompanyStreamLifecycle(lifecycle, controller, 4);

    expect(lifecycle.current).toBe(5);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(controller.current).toBeNull();
  });
});
