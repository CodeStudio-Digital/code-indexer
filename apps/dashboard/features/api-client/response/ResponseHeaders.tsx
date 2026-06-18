/** Response headers table + copy-all. */
import { Copy } from 'lucide-react';
import { Button } from '../../../components/ui/button.js';

export function ResponseHeaders({ headers }: { headers: Record<string, string | string[] | undefined> }) {
  const entries = Object.entries(headers);
  const copyAll = () => {
    const text = entries.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v ?? ''}`).join('\n');
    void navigator.clipboard?.writeText(text);
  };
  return (
    <div className="p-2">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 text-[11px] text-muted-foreground" onClick={copyAll}>
          <Copy className="h-3 w-3" /> Copy all
        </Button>
      </div>
      <table className="text-xs font-mono w-full">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-b border-border/30">
              <td className="pr-3 py-0.5 text-muted-foreground align-top">{k}</td>
              <td className="py-0.5 break-all">{Array.isArray(v) ? v.join(', ') : String(v ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
