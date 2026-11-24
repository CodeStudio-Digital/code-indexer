import type { CompanyPanelReceipt } from '@mcp/company-contracts';

// The HTTP receipt and the app-wide SSE can arrive in either order.
const seen = new Set<string>();
const listeners = new Set<(receipt: CompanyPanelReceipt) => void>();

export function applyCompanyPanelReceipt(receipt: CompanyPanelReceipt): void {
  if (!receipt?.id || !receipt.sessionId || !receipt.change || seen.has(receipt.id)) return;
  seen.add(receipt.id);
  if (seen.size > 256) seen.delete(seen.values().next().value!);
  for (const listener of listeners) listener(receipt);
}

export function onCompanyPanelChange(listener: (receipt: CompanyPanelReceipt) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
