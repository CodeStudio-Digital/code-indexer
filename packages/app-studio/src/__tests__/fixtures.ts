import type { AppSpec } from '../spec/types.js';

/** Spec válida mínima: lanchonete com pedidos + clientes, login por senha. */
export function makeSpec(overrides: Partial<AppSpec> = {}): AppSpec {
  return {
    v: 1,
    summary: 'Gerencia os pedidos da lanchonete da Ana',
    audience: 'dona de lanchonete',
    locale: 'pt-BR',
    features: [
      { id: 'gestao-pedidos', name: 'Gestão de pedidos', description: 'criar e acompanhar pedidos', screen_ids: ['painel'] },
    ],
    screens: [
      { id: 'painel', name: 'PainelScreen', label: 'Painel de pedidos', purpose: 'ver e criar pedidos', primary: true },
    ],
    database: {
      required: true,
      entities: [
        {
          name: 'pedidos',
          label: 'Pedidos',
          fields: [
            { name: 'cliente', label: 'Nome do cliente', type: 'text', required: true },
            { name: 'total', label: 'Valor total', type: 'real' },
          ],
        },
      ],
    },
    auth: { enabled: false },
    design: { tone: 'clean e amigável' },
    ...overrides,
  };
}
