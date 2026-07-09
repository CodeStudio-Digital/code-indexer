import { describe, expect, it } from 'vitest';
import { validateAppSpec } from '../spec/validate.js';
import { normalizeAppSpec } from '../spec/normalize.js';
import { prepareSpecSave } from '../spec/save-core.js';
import { createPipelineState, parsePipelineState, serializePipelineState } from '../pipeline/stages.js';
import type { AppSpec } from '../spec/types.js';
import { makeSpec } from './fixtures.js';

function withBehaviors(behaviors: unknown): AppSpec {
  return { ...makeSpec(), behaviors: behaviors as AppSpec['behaviors'] };
}

describe('behaviors — validate', () => {
  it('accepts a valid behavior and stays optional', () => {
    expect(validateAppSpec(makeSpec())).toEqual([]); // sem behaviors
    const spec = withBehaviors([
      {
        id: 'salvar-pedido',
        screen_id: 'painel',
        trigger: 'submit',
        trigger_label: 'ao enviar o formulário',
        actions: [
          { kind: 'save', entity: 'pedidos' },
          { kind: 'notify', message: 'Pedido salvo!' },
        ],
      },
    ]);
    expect(validateAppSpec(spec)).toEqual([]);
  });

  it('flags unknown refs, bad triggers/kinds, empty actions and duplicate ids', () => {
    const spec = withBehaviors([
      { id: 'a', screen_id: 'ghost', trigger: 'hover', trigger_label: 'x', actions: [] },
      { id: 'a', screen_id: 'painel', trigger: 'click', trigger_label: 'y', actions: [{ kind: 'save', entity: 'nope' }] },
      { id: 'b', screen_id: 'painel', trigger: 'click', trigger_label: 'z', actions: [{ kind: 'navigate', screen_id: 'ghost' }] },
    ]);
    const issues = validateAppSpec(spec).join('\n');
    expect(issues).toContain("unknown screen 'ghost'");
    expect(issues).toContain('trigger must be click|submit|open');
    expect(issues).toContain('at least 1 action');
    expect(issues).toContain("'a' is duplicated");
    expect(issues).toContain("unknown entity 'nope'");
    expect(issues).toContain("(navigate) references unknown screen 'ghost'");
  });
});

describe('behaviors — normalize', () => {
  it('coerces natural model output (aliases, missing id, kebab/snake)', () => {
    const raw = {
      ...makeSpec(),
      behaviors: [
        {
          screen: 'Painel', // screen em vez de screen_id, capitalizado
          trigger: 'on_submit',
          label: 'Ao enviar o formulário de pedido',
          actions: [
            { type: 'save_to', table: 'Pedidos' },
            { action: 'toast', text: 'Salvo!' },
            { kind: 'goto', to: 'painel' },
          ],
        },
      ],
    };
    const spec = normalizeAppSpec(raw) as AppSpec;
    expect(validateAppSpec(spec)).toEqual([]);
    const b = spec.behaviors![0];
    expect(b.id).toBe('ao-enviar-o-formulario-de-pedido');
    expect(b.screen_id).toBe('painel');
    expect(b.trigger).toBe('submit');
    expect(b.actions).toEqual([
      { kind: 'save', entity: 'pedidos' },
      { kind: 'notify', message: 'Salvo!' },
      { kind: 'navigate', screen_id: 'painel' },
    ]);
  });
});

describe('prepareSpecSave (save-core)', () => {
  it('normalizes, validates and rebuilds the roadmap', () => {
    const pipeline = serializePipelineState(createPipelineState());
    const result = prepareSpecSave(makeSpec(), pipeline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.specJson)).toEqual(result.spec);
    expect(result.mirrorJson).toContain('\n'); // pretty
    const state = parsePipelineState(result.pipelineJson)!;
    expect(state.roadmap.length).toBeGreaterThan(0);
  });

  it('returns issues on invalid spec and null pipeline when input pipeline is null', () => {
    const bad = prepareSpecSave({ v: 1 }, null);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.length).toBeGreaterThan(0);

    const good = prepareSpecSave(makeSpec(), null);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.pipelineJson).toBeNull();
  });
});
