import { describe, it, expect } from 'vitest';
import { zaiSpec, cloudflareSpec, openrouterSpec, fuguSpec } from '../specs/openai-compat.js';
import { moonshotSpec } from '../specs/moonshot.js';
import { copilotSpec } from '../specs/copilot.js';
import { chatgptSpec } from '../specs/chatgpt.js';
import { claudeCodeSpec } from '../specs/claude-code.js';
import { googleOAuthSpec } from '../specs/google-oauth.js';
import { kimiCodeSpec } from '../specs/kimi.js';
import { bedrockSpec } from '../specs/bedrock.js';
import cloudflarePlugin from '../../../../extensions/provider-cloudflare/src/plugin.js';
import openrouterPlugin from '../../../../extensions/provider-openrouter/src/plugin.js';
import moonshotPlugin from '../../../../extensions/provider-moonshot/src/plugin.js';
import zaiPlugin from '../../../../extensions/provider-zai/src/plugin.js';
import copilotPlugin from '../../../../extensions/provider-copilot/src/plugin.js';
import chatgptPlugin from '../../../../extensions/provider-chatgpt/src/plugin.js';
import claudeCodePlugin from '../../../../extensions/provider-claude-code/src/plugin.js';
import googleOAuthPlugin from '../../../../extensions/provider-google-oauth/src/plugin.js';
import kimiCodePlugin from '../../../../extensions/provider-kimi-code/src/plugin.js';
import bedrockPlugin from '../../../../extensions/provider-bedrock/src/plugin.js';
import fuguPlugin from '../../../../extensions/provider-fugu/src/plugin.js';

/**
 * Drift guard: every bundled provider plugin (API-key + OAuth/AWS
 * connectors) re-exports the CANONICAL engine spec — single source of truth.
 * A forked plugin that inlines a divergent spec fails here.
 */
const cases = [
  { name: 'cloudflare', plugin: cloudflarePlugin, spec: cloudflareSpec },
  { name: 'openrouter', plugin: openrouterPlugin, spec: openrouterSpec },
  { name: 'moonshot', plugin: moonshotPlugin, spec: moonshotSpec },
  { name: 'zai', plugin: zaiPlugin, spec: zaiSpec },
  { name: 'fugu', plugin: fuguPlugin, spec: fuguSpec },
  { name: 'copilot', plugin: copilotPlugin, spec: copilotSpec },
  { name: 'chatgpt', plugin: chatgptPlugin, spec: chatgptSpec },
  { name: 'claude-code', plugin: claudeCodePlugin, spec: claudeCodeSpec },
  { name: 'google-oauth', plugin: googleOAuthPlugin, spec: googleOAuthSpec },
  { name: 'kimi-code', plugin: kimiCodePlugin, spec: kimiCodeSpec },
  { name: 'bedrock', plugin: bedrockPlugin, spec: bedrockSpec },
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
