import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../AgentSessionModal.js', () => ({ AgentSessionModal: () => null }));
import { DispatchReviewNotice } from '../KanbanDispatchReview.js';
import { readDispatchReview, submitDispatchReview } from '../kanban-dispatch-review-api.js';
afterEach(() => vi.unstubAllGlobals());
describe('Dispatch review UI feedback', () => {
  it('preserves actionable server refusal and renders it as a visible alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Pause a sessão responsável antes de revisar o despacho.' }), { status: 409 })));
    let message = '';
    try { await submitDispatchReview('session', 'card', { token: 'exact-token', epoch: 3, phase: 'uncertain', leaseUntil: 0 }); }
    catch (error) { message = (error as Error).message; }
    const html = renderToStaticMarkup(createElement(DispatchReviewNotice, { error: message }));
    expect(html).toContain('role="alert"'); expect(html).toContain('Pause a sessão responsável');
  });
  it('sends only the exact reviewed token and epoch, never a dispatch instruction', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true,"dispatched":false}'));
    vi.stubGlobal('fetch', fetch);
    await submitDispatchReview('session', 'card', { token: 'exact-token', epoch: 3, phase: 'uncertain', leaseUntil: 0 });
    expect(fetch).toHaveBeenCalledWith('/api/company/sessions/session/kanban/cards/card/dispatch-review', expect.objectContaining({ method: 'POST', body: JSON.stringify({ reviewed: true, token: 'exact-token', epoch: 3 }) }));
  });
  it('surfaces failed evidence loading instead of hiding a blocked claim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Não foi possível comprovar o estado do responsável."}', { status: 409 })));
    await expect(readDispatchReview('session', 'card')).rejects.toThrow('Não foi possível comprovar');
    expect(renderToStaticMarkup(createElement(DispatchReviewNotice, { error: null }))).toBe('');
  });
});
