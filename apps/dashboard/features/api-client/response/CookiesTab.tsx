import { useTranslation } from 'react-i18next';

/** Cookies in the per-collection jar for the response host. */
export function CookiesTab({ cookies = [] }: { cookies?: { name: string; value: string }[] }) {
  const { t } = useTranslation('apiClient');
  if (!cookies.length) {
    return <div className="h-full flex items-center justify-center text-xs text-muted-foreground p-4 text-center">{t('cookies.emptyState')}</div>;
  }
  return (
    <table className="text-xs font-mono w-full p-2">
      <tbody>
        {cookies.map((c) => (
          <tr key={c.name} className="border-b border-border/30">
            <td className="pr-3 py-0.5 text-muted-foreground align-top">{c.name}</td>
            <td className="py-0.5 break-all">{c.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
