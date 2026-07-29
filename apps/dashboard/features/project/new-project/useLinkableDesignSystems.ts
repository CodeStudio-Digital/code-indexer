/**
 * Published design systems a builder project could link. Every published DS
 * is returned — incompatible stacks (e.g. an Angular DS for a react-vite
 * project) come back with `compatible: false` so pickers can show them
 * DISABLED with the reason instead of hiding them silently.
 */
import { useEffect, useState } from 'react';
import {
  listDesignSystemSessions,
  type DsStack,
} from '../../design-systems/design-system-api.js';

export interface LinkableDs {
  sessionId: string;
  name: string;
  packageName: string;
  stack: DsStack;
  /** Latest published semver. */
  semver: string;
  compatible: boolean;
}

export function useLinkableDesignSystems(targetStack: string, enabled = true) {
  const [items, setItems] = useState<LinkableDs[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    listDesignSystemSessions()
      .then((sessions) => {
        if (cancelled) return;
        setItems(
          sessions
            .filter((s) => s.latest_published_semver)
            .map((s) => ({
              sessionId: s.id,
              name: s.name,
              packageName: s.package_name,
              stack: s.stack,
              semver: s.latest_published_semver!,
              compatible: s.stack === targetStack,
            })),
        );
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetStack, enabled]);

  return { items, loading, error };
}

/** True when `candidate` is a strictly newer 3-segment semver than `pinned`. */
export function isNewerSemver(candidate: string, pinned: string): boolean {
  const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(candidate), parse(pinned)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
