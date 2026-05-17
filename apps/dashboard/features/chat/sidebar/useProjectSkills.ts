import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminSkill } from '../../admin/skills-api.js';

export interface SessionSkill extends AdminSkill {
  /** Effective enabled state for this session, applying session-level overrides. */
  session_enabled: boolean;
  /** Whether the resolver currently surfaces this skill in the prompt. */
  is_active: boolean;
}

interface SkillsResponse {
  skills: SessionSkill[];
  active_count: number;
}

/**
 * Fetches skills resolved for the given session (global + project + session
 * overrides) from `GET /api/coder/sessions/:id/skills`. Exposes a debounced
 * client-side search filter — the catalog is small enough that we filter
 * locally rather than re-hitting the server on every keystroke.
 */
export function useProjectSkills(sessionId: number | null) {
  const [skills, setSkills] = useState<SessionSkill[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => clearTimeout(h);
  }, [search]);

  useEffect(() => {
    if (sessionId == null) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/coder/sessions/${sessionId}/skills`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return (await r.json()) as SkillsResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setSkills(data.skills);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey]);

  const filtered = useMemo(() => {
    // Only show skills the session can actually use. Globally disabled skills
    // are hidden because forcing them in the prompt despite an admin disable
    // would be confusing — admin disable is meant to keep them out of context.
    const enabled = skills.filter((s) => s.session_enabled && s.enabled);
    if (debouncedSearch.length === 0) return enabled;
    return enabled.filter((s) => {
      const hay = [s.id, s.name, s.description, ...(s.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(debouncedSearch);
    });
  }, [skills, debouncedSearch]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return {
    skills: filtered,
    rawCount: skills.length,
    loading,
    error,
    search,
    setSearch,
    reload,
  };
}
