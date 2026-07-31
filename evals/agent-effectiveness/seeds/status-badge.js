const STATUS = {
  active: { label: 'Ativo', modifier: 'active' },
  paused: { label: 'Em pausa', modifier: 'active' },
};

export function renderStatusBadge(status) {
  const item = STATUS[status] ?? { label: 'Desconhecido', modifier: 'unknown' };
  return `<span class="status-badge status-badge--${item.modifier}" role="status">${item.label}</span>`;
}

