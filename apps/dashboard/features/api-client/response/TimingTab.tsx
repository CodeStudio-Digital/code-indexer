/** Timing / size / status summary for the last response. */
import { useTranslation } from 'react-i18next';
import type { SendResponse } from '../types.js';
import { formatBytes } from './format-body.js';

export function TimingTab({ response }: { response: SendResponse }) {
  const { t } = useTranslation('apiClient');
  const rows: Array<[string, string]> = [
    [t('timing.status'), `${response.status} ${response.statusText}`],
    [t('timing.time'), `${response.ms} ms`],
    [
      t('timing.size'),
      `${formatBytes(response.size ?? response.body.length)}${response.truncated ? ` ${t('timing.truncated')}` : ''}`,
    ],
    [t('timing.url'), response.url],
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
