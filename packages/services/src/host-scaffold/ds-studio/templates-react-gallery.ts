/**
 * DS Studio — arquivos da galeria react (app/src). A galeria é a vitrine
 * viva do design system: TokensPage renderiza os tokens correntes e o
 * `registry.tsx` é o mapa nome→demo que o agente estende a cada componente.
 */
import { THEME_INLINE } from '../../sandbox/builder/scaffold/shadcn-files.js';

/**
 * index.css da galeria (Tailwind v4, CSS-first). Tokens da LIB primeiro
 * (`@ds/tokens.css`), depois o Tailwind. Como a lib (`../pkg/src`) vive
 * FORA do root do `app/`, a auto-detecção de conteúdo do v4 não a varre —
 * por isso o `@source` explícito (substitui o glob que ficava no
 * `tailwind.config.cjs` do v3). Path é relativo a este CSS (`app/src/`).
 * O teste trava a presença do `@source` — se sumir, ele acusa.
 */
export const APP_INDEX_CSS = String.raw`@import '@ds/tokens.css';
@import "tailwindcss";
@import "tw-animate-css";

@source '../../pkg/src/**/*.{ts,tsx,js,jsx}';

@custom-variant dark (&:is(.dark *));

${THEME_INLINE}

@layer base {
  * {
    border-color: hsl(var(--border));
  }
  body {
    background-color: hsl(var(--background));
    color: hsl(var(--foreground));
  }
}
`;

export const APP_MAIN_TSX = String.raw`import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`;

export const APP_APP_TSX = String.raw`import { useEffect, useState } from 'react';
import { TokensPage } from './gallery/TokensPage';
import { demos } from './gallery/registry';

/**
 * Gallery shell. Hash-based navigation: #/ → tokens, #/<Component> → demo.
 * The DS agent adds entries to ./gallery/registry — this shell discovers
 * them automatically.
 */
export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.slice(2) || 'tokens');
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.slice(2) || 'tokens');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const names = Object.keys(demos).sort();
  const item = (active: boolean) =>
    'block w-full rounded-md px-3 py-1.5 text-left text-sm ' +
    (active ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-foreground');

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="w-56 shrink-0 border-r border-border p-3 space-y-1">
        <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Design system
        </p>
        <a href="#/" className={item(route === 'tokens')}>Tokens</a>
        <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Components
        </p>
        {names.length === 0 && (
          <p className="px-3 text-xs text-muted-foreground">None yet — build one in the chat.</p>
        )}
        {names.map((name) => (
          <a key={name} href={'#/' + name} className={item(route === name)}>
            {name}
          </a>
        ))}
      </aside>
      <main className="flex-1 p-8">
        {route === 'tokens' ? (
          <TokensPage />
        ) : demos[route] ? (
          <section>
            <h1 className="mb-6 text-2xl font-bold">{route}</h1>
            {demos[route]}
          </section>
        ) : (
          <p className="text-muted-foreground">Unknown route.</p>
        )}
      </main>
    </div>
  );
}
`;

export const APP_GALLERY_REGISTRY_TSX = String.raw`import type { ReactNode } from 'react';

/**
 * Gallery registry — ONE entry per design-system component, showing its
 * variants and states. The DS agent keeps this in sync with pkg/src:
 *
 *   import { Button } from '@ds';
 *   export const demos: Record<string, ReactNode> = {
 *     Button: (
 *       <div className="flex flex-wrap gap-3">
 *         <Button>Primary</Button>
 *         <Button variant="secondary">Secondary</Button>
 *         <Button disabled>Disabled</Button>
 *       </div>
 *     ),
 *   };
 */
export const demos: Record<string, ReactNode> = {};
`;

export const APP_TOKENS_PAGE_TSX = String.raw`const COLOR_TOKENS = [
  'background', 'foreground', 'card', 'popover', 'primary', 'secondary',
  'muted', 'accent', 'destructive', 'border', 'input', 'ring',
];

function Swatch({ token }: { token: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div
        className="mb-2 h-12 w-full rounded-md border border-border"
        style={{ background: 'hsl(var(--' + token + '))' }}
      />
      <p className="font-mono text-xs">--{token}</p>
    </div>
  );
}

/** Renders the CURRENT values of pkg/src/tokens.css — the living theme. */
export function TokensPage() {
  return (
    <section>
      <h1 className="mb-2 text-2xl font-bold">Design tokens</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Defined in <code className="font-mono">pkg/src/tokens.css</code>. Change a token there and
        every component re-themes.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {COLOR_TOKENS.map((t) => (
          <Swatch key={t} token={t} />
        ))}
      </div>
      <h2 className="mb-3 mt-8 text-lg font-semibold">Radius</h2>
      <div className="flex items-end gap-4">
        {(['sm', 'md', 'lg'] as const).map((r) => (
          <div key={r} className="text-center">
            <div className={'h-16 w-16 border-2 border-primary bg-secondary rounded-' + r} />
            <p className="mt-1 font-mono text-xs">rounded-{r}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
`;
