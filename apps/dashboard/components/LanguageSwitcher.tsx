import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { Button } from './ui/button.js';

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const currentLang = i18n.language?.startsWith('pt') ? 'pt-BR' : 'en';
  const label = currentLang === 'pt-BR' ? 'PT' : 'EN';

  const toggle = () => {
    const next = currentLang === 'pt-BR' ? 'en' : 'pt-BR';
    i18n.changeLanguage(next);
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} title={t('language.toggle')} className="gap-1 w-auto px-2">
      <Globe className="h-4 w-4" />
      <span className="text-xs font-medium">{label}</span>
    </Button>
  );
}
