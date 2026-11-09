import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { Markdown } from '../../features/chat/messages/Markdown.js';
import '../../index.css';

await i18next.init({ lng: 'en', resources: {}, interpolation: { escapeValue: false } });
const code = Array.from({ length: 1_500 }, (_, index) =>
  `export const syntheticValue${index} = { id: ${index}, label: "synthetic fixture ${index}", enabled: true };`).join('\n');
const source = Array.from({ length: 3 }, (_, index) => `## Example ${index + 1}\n\n\`\`\`typescript\n${code}\n\`\`\``).join('\n\n');

declare global {
  interface Window {
    loadMarkdownStress: () => void;
    markdownStress: { sourceChars: number; codeChars: number; copied: string; copyComplete: () => boolean };
  }
}
window.markdownStress = { sourceChars: source.length, codeChars: code.length, copied: '', copyComplete: () => window.markdownStress.copied === code };
// Keep synthetic acceptance tests from replacing the user's actual clipboard.
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (value: string) => { window.markdownStress.copied = value; },
} });

function Fixture() {
  const [text, setText] = useState('');
  const [probe, setProbe] = useState('');
  window.loadMarkdownStress = () => setText(source);
  return <main className="bg-background p-4 text-foreground">
    <label>Responsiveness probe <input aria-label="Responsiveness probe" value={probe}
      onChange={event => setProbe(event.target.value)} className="border bg-background" /></label>
    <output data-probe>{probe}</output>
    <section data-markdown><Markdown text={text} /></section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<I18nextProvider i18n={i18next}><Fixture /></I18nextProvider>);
