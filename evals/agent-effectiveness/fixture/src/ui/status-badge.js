const STATUS = {
  active: { label: 'Ativo', modifier: 'active' },
  paused: { label: 'Pausado', modifier: 'paused' },
};

export function renderStatusBadge(status) {
  const item = STATUS[status] ?? { label: 'Desconhecido', modifier: 'unknown' };
  return `<span class="status-badge status-badge--${item.modifier}" role="status" aria-live="polite">${item.label}</span>`;
}
