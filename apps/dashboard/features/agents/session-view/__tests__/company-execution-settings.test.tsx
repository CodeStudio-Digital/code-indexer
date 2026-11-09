import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanySession } from '@mcp/company-contracts';

const api = vi.hoisted(() => vi.fn((_url: string) => ({ data: { owners: [] }, error: null, refetch: vi.fn() })));
vi.mock('../../../../hooks/useApi.js', () => ({ useApi: api }));
vi.mock('../../AgentSessionModal.js', () => ({ AgentSessionModal: () => null }));
import { CompanyExecutionSettings, type CompanyExecutionFamily } from '../CompanyExecutionSettings.js';

function record(id: string, status: string, revision: string): CompanySession {
  return { id, name: id, status, config_json: JSON.stringify({ master_model: revision }), configuration: { mode: 'snapshot', revision } } as CompanySession;
}
function render(family: CompanyExecutionFamily) {
  return renderToStaticMarkup(createElement(CompanyExecutionSettings, {
    companyId: 'company', sessionId: 'child', family, revision: 1, onChanged: vi.fn(),
  }));
}
function family(status = 'running', parentRevision = 'new'): CompanyExecutionFamily {
  return { parent: record('company', 'idle', parentRevision), children: [record('child', status, 'old')], error: null, refresh: vi.fn() };
}
function adoptButton(html: string) {
  return html.match(/<button\b[^>]*>Adotar configuração da empresa<\/button>/)?.[0];
}

beforeEach(() => api.mockClear());
describe('Company execution settings family updates', () => {
  it('unlocks adoption when the authoritative session changes from running to completed', () => {
    expect(adoptButton(render(family('running')))).toContain(' disabled=""');
    expect(adoptButton(render(family('completed')))).not.toContain(' disabled=""');
    expect(api.mock.calls.every(args => args[0] === '/company/companies/company/workspace')).toBe(true);
  });

  it('shows configuration differences from the current family rather than a second cached request', () => {
    expect(adoptButton(render(family('idle', 'old')))).toBeUndefined();
    expect(adoptButton(render(family('idle', 'new')))).toBeDefined();
    expect(api).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.flat()).not.toContain('/company/companies/company/sessions');
  });

  it('keeps the active session selection exact when a sibling is running', () => {
    const current = family('idle');
    current.children.unshift(record('other', 'running', 'other-revision'));
    expect(adoptButton(render(current))).not.toContain(' disabled=""');
    expect(adoptButton(render({ ...current, children: current.children.filter(item => item.id !== 'child') }))).toBeUndefined();
  });
});
