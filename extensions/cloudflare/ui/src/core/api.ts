/** Thin layer over window.mcp tool calls: error normalization, data
 *  extraction, toasts and danger confirmation. */
import { mcp, type ToolResult } from './mcp.js';
import { t } from './i18n.js';

export type Row = Record<string, unknown>;

/** Invoke a plugin tool; rejects with a readable Error when isError. */
export async function call(tool: string, args?: Record<string, unknown>): Promise<ToolResult> {
  const r = await mcp.invokeTool(tool, args ?? {});
  if (r.isError) throw new Error(r.content || t('error.toolFailed'));
  return r;
}

/** Structured rows from a PluginToolResult.data payload (rows convention). */
export function rowsOf(r: ToolResult | null | undefined): Row[] {
  const data = r?.data as { rows?: unknown } | undefined;
  return Array.isArray(data?.rows) ? (data.rows as Row[]) : [];
}

/** Structured details from a result (details convention, else data itself). */
export function detailsOf(r: ToolResult | null | undefined): unknown {
  const data = r?.data as { details?: unknown } | undefined;
  return data?.details ?? r?.data ?? {};
}

export function toast(kind: 'info' | 'success' | 'error' | 'warning', message: string): void {
  void mcp.ui.toast({ kind, message });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Host-rendered destructive confirmation dialog. */
export function confirmDanger(title: string, message?: string): Promise<boolean> {
  return mcp.ui.confirm({
    title,
    message,
    danger: true,
    confirmText: t('common.confirm'),
    cancelText: t('common.cancel'),
  });
}

/**
 * Run a mutating tool with success/error toasts. `danger` (a dialog title)
 * gates the call behind a host confirm dialog. Resolves null when the user
 * bails or the tool fails — callers reload only on a non-null result.
 */
export async function mutate(
  tool: string,
  args: Record<string, unknown>,
  opts?: { danger?: string; detail?: string },
): Promise<ToolResult | null> {
  if (opts?.danger) {
    const ok = await confirmDanger(opts.danger, opts.detail);
    if (!ok) return null;
  }
  try {
    const r = await call(tool, args);
    toast('success', r.content || t('common.done'));
    return r;
  } catch (e) {
    toast('error', errorMessage(e));
    return null;
  }
}

/** JSON.parse with a translated error toast; returns null on bad input. */
export function parseJsonOr(text: string, fallback: unknown): unknown {
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    toast('error', t('error.badJson'));
    return null;
  }
}
