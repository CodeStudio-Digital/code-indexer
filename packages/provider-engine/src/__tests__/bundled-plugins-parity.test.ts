import { describe, it, expect } from 'vitest';
import { zaiSpec, cloudflareSpec, openrouterSpec } from '../specs/openai-compat.js';
import { moonshotSpec } from '../specs/moonshot.js';
import cloudflarePlugin from '../../../../extensions/provider-cloudflare/src/plugin.js';
import openrouterPlugin from '../../../../extensions/provider-openrouter/src/plugin.js';
import moonshotPlugin from '../../../../extensions/provider-moonshot/src/plugin.js';
import zaiPlugin from '../../../../extensions/provider-zai/src/plugin.js';

/**
 * Drift guard: each bundled api-key provider plugin re-exports the CANONICAL
 * engine spec (single source of truth). If someone edits the engine spec, the
 * plugin's `.app.json` (built from this same object) stays in lockstep — and if
 * someone forks the plugin to inline a divergent spec, this test fails.
 */
const cases = [
  { name: 'cloudflare', plugin: cloudflarePlugin, spec: cloudflareSpec },
  { name: 'openrouter', plugin: openrouterPlugin, spec: openrouterSpec },
  { name: 'moonshot', plugin: moonshotPlugin, spec: moonshotSpec },
  { name: 'zai', plugin: zaiPlugin, spec: zaiSpec },
] as const;

describe('bundled provider plugins re-export the canonical engine spec', () => {
  for (const { name, plugin, spec } of cases) {
    it(`${name}: contributes exactly the canonical spec (no drift)`, () => {
      expect(plugin.providers).toBeDefined();
      expect(plugin.providers).toHaveLength(1);
      expect(plugin.providers![0]).toEqual(spec);
    });
  }
});
