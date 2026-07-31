import assert from 'node:assert/strict';
import test from 'node:test';
import { renderStatusBadge } from '../src/ui/status-badge.js';

test('renders an accessible paused status', () => {
  assert.equal(
    renderStatusBadge('paused'),
    '<span class="status-badge status-badge--paused" role="status" aria-live="polite">Pausado</span>',
  );
});

test('preserves the active status', () => {
  assert.equal(
    renderStatusBadge('active'),
    '<span class="status-badge status-badge--active" role="status" aria-live="polite">Ativo</span>',
  );
});

