import { describe, it, expect } from 'vitest';
import {
  resolveTemperature,
  DEFAULT_TEMPERATURE,
} from '../core/coder/inference/temperature.js';
import { AGENTS } from '../core/coder/agents/index.js';

describe('resolveTemperature', () => {
  describe('precedence', () => {
    it('session override wins over role/agent/default', () => {
      const r = resolveTemperature({
        agent: 'explore',
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        sessionOverride: 0.55,
        roleOverride: 0.7,
      });
      expect(r.source).toBe('session');
      expect(r.temperature).toBe(0.55);
    });

    it('role override wins over agent/default when no session override', () => {
      const r = resolveTemperature({
        agent: 'build',
        providerName: 'openai',
        model: 'gpt-4o',
        sessionOverride: null,
        roleOverride: 0.6,
      });
      expect(r.source).toBe('role');
      expect(r.temperature).toBe(0.6);
    });

    it('agent preset wins over default when nothing else set', () => {
      const r = resolveTemperature({
        agent: 'plan',
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
      });
      expect(r.source).toBe('agent');
      expect(r.temperature).toBe(AGENTS.plan.defaultTemperature);
    });

    it('falls through to global default when agent is null', () => {
      const r = resolveTemperature({
        agent: null,
        providerName: 'openai',
        model: 'gpt-4o',
      });
      expect(r.source).toBe('default');
      expect(r.temperature).toBe(DEFAULT_TEMPERATURE);
    });
  });

  describe('agent preset values', () => {
    it('explore is low (factual)', () => {
      expect(AGENTS.explore.defaultTemperature).toBeLessThanOrEqual(0.3);
    });
    it('plan is moderate (brainstorm)', () => {
      expect(AGENTS.plan.defaultTemperature).toBeGreaterThan(AGENTS.build.defaultTemperature ?? 0);
    });
    it('admin is the lowest (deterministic)', () => {
      const all = Object.values(AGENTS).map((a) => a.defaultTemperature ?? 1);
      expect(AGENTS.admin.defaultTemperature).toBe(Math.min(...all));
    });
  });

  describe('skip rules', () => {
    it('skips for OpenAI o-series reasoning models', () => {
      const r = resolveTemperature({
        agent: 'build',
        providerName: 'openai',
        model: 'o3-mini',
        sessionOverride: 0.5,
      });
      expect(r.source).toBe('skipped');
      expect(r.reason).toBe('reasoning_model');
      expect(r.temperature).toBeUndefined();
    });

    it('skips for gpt-5-reasoning variants', () => {
      const r = resolveTemperature({
        agent: 'build',
        providerName: 'openai',
        model: 'gpt-5-reasoning-preview',
      });
      expect(r.source).toBe('skipped');
      expect(r.reason).toBe('reasoning_model');
    });

    it('skips for Anthropic with thinking enabled', () => {
      const r = resolveTemperature({
        agent: 'plan',
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        thinking: true,
      });
      expect(r.source).toBe('skipped');
      expect(r.reason).toBe('thinking_enabled');
    });

    it('does NOT skip for Gemini with thinking — thinkingConfig is independent', () => {
      const r = resolveTemperature({
        agent: 'plan',
        providerName: 'gemini',
        model: 'gemini-2.5-flash',
        thinking: true,
      });
      expect(r.source).not.toBe('skipped');
      expect(typeof r.temperature).toBe('number');
    });

    it('does NOT skip for OpenAI gpt-4o or non-reasoning models', () => {
      const r = resolveTemperature({
        agent: 'build',
        providerName: 'openai',
        model: 'gpt-4o',
      });
      expect(r.source).not.toBe('skipped');
    });

    it('skips for Kimi Code K2 and thinking models', () => {
      const k26 = resolveTemperature({
        agent: 'build',
        providerName: 'kimi-code',
        model: 'kimi-k2.6',
      });
      expect(k26.source).toBe('skipped');
      expect(k26.reason).toBe('thinking_enabled');

      const thinking = resolveTemperature({
        agent: 'build',
        providerName: 'kimi-code',
        model: 'kimi-k2-thinking',
        thinking: false,
      });
      expect(thinking.source).toBe('skipped');
    });
  });

  describe('clamping', () => {
    it('clamps session override above 1 to 1', () => {
      const r = resolveTemperature({
        agent: 'build',
        providerName: 'anthropic',
        model: 'claude-sonnet-4-6',
        sessionOverride: 5,
      });
      expect(r.temperature).toBe(1);
      expect(r.source).toBe('session');
    });

    it('clamps negative role override to 0', () => {
      const r = resolveTemperature({
        agent: 'build',
        providerName: 'openai',
        model: 'gpt-4o',
        roleOverride: -2,
      });
      expect(r.temperature).toBe(0);
      expect(r.source).toBe('role');
    });

    it('returns default for non-finite session override', () => {
      const r = resolveTemperature({
        agent: 'build',
        providerName: 'openai',
        model: 'gpt-4o',
        sessionOverride: Number.NaN,
      });
      expect(r.temperature).toBe(DEFAULT_TEMPERATURE);
      expect(r.source).toBe('session');
    });
  });
});
