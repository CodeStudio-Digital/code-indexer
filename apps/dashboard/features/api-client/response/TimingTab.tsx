/** Timing / size / status summary for the last response. */
import type { SendResponse } from '../types.js';

export function TimingTab({ response }: { response: SendResponse }) {
  const rows: Array<[string, string]> = [
    ['Status', `${response.status} ${response.statusText}`],
    ['Time', `${response.ms} ms`],
    ['Size', `${formatBytes(response.size ?? response.body.length)}${response.truncated ? ' (truncated)' : ''}`],
    ['URL', response.url],
  ];
  return (
    <table className="text-xs w-full p-2">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k} className="border-b border-border/30">
            <td className="pr-3 py-1 text-muted-foreground align-top w-20">{k}</td>
            <td className="py-1 break-all font-mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
