/**
 * Anti-bloat + regression guard for tool-INPUT schemas.
 *
 * A tool's `parameters` are serialized verbatim into the model's context and
 * form the first segment of the provider prompt-cache prefix, so every extra
 * argument is permanent cognitive load for the agent (and a cache cost). These
 * invariants lock in the argument trim that killed the "read_file has too many
 * args" confusion:
 *   - the dead `project` param never creeps back onto the fs tools (it is inert
 *     under the virtual-union global-session model — selectRoot resolves the
 *     primary root when it is absent, and refuses when present),
 *   - read_file keeps its slim 5-param surface (no re-introduction of the
 *     overlapping symbol/around_line/search_term/force_reread modes),
 *   - the high-frequency, always-visible tools stay under a hard arg ceiling.
 *
 * Heavy specialist tools (manage_path, create_skill, http_request) are
 * intentionally exempt: their params are operation-scoped / navigate-tier, not
 * hot bootstrap surface. Exempt does not mean unguarded — they get an exact
 * param-set assertion instead of the ceiling.
 */
import { describe, it, expect } from 'vitest';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { fsTools } from '../fs.js';
import { shellTools } from '../shell.js';
import { httpRequestTool } from '../http.js';

function propNames(t: CoderTool): string[] {
  const props = (t.parameters as JsonSchema | undefined)?.properties;
  return props && typeof props === 'object' ? Object.keys(props) : [];
}

describe('tool schema invariants — fs tools', () => {
  it('no native fs tool re-declares the inert `project`/`project_name` param', () => {
    for (const t of fsTools) {
      expect(propNames(t), `${t.name} must not re-add a project param`).not.toContain('project');
      expect(propNames(t), `${t.name} must not re-add a project param`).not.toContain('project_name');
    }
  });

  it('read_file exposes exactly its 5-param surface', () => {
    const readFile = fsTools.find((t) => t.name === 'read_file')!;
    expect(new Set(propNames(readFile))).toEqual(
      new Set(['path', 'start_line', 'end_line', 'symbol', 'force']),
    );
  });

  it('http_request exposes exactly its declared surface', () => {
    // Navigate-tier, so it is exempt from the always-on ceiling below — but it
    // still may not grow silently. `timeoutMs`/`insecure` were already read by
    // the handler before being declared; `maxBytes`/`resetCookies` back the
    // network-read ceiling and the cookie-jar reset.
    expect(new Set(propNames(httpRequestTool))).toEqual(
      new Set([
        'url', 'method', 'headers', 'json', 'body',
        'timeoutMs', 'insecure', 'resetCookies', 'maxBytes',
      ]),
    );
  });
});

describe('tool schema invariants — always-on argument ceiling', () => {
  const CEILING = 6;
  // manage_path (operation-scoped, 7 params) and http_request (navigate-tier,
  // 9 params — pinned exactly above) are deliberately excluded.
  const alwaysOn: CoderTool[] = [
    ...fsTools.filter((t) => t.name !== 'manage_path'),
    ...shellTools,
  ];

  for (const t of alwaysOn) {
    it(`${t.name} stays at or under ${CEILING} top-level args`, () => {
      expect(propNames(t).length).toBeLessThanOrEqual(CEILING);
    });
  }
});
