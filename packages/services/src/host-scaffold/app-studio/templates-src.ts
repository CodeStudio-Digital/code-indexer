/**
 * Arquivos da SPA do template `cf-fullstack` — entry, router dirigido pelo
 * registry de telas (o gate da etapa design confere os screen ids AQUI),
 * tela inicial placeholder, client de API e módulo de mock (as telas
 * nascem em mock na etapa design; a etapa backend troca para lib/api).
 *
 * O entry já importa o inspector do Builder (dev-only) — mesmo runtime de
 * seleção de elemento dos projetos builder (`src/mcp-inspector.ts` é
 * escrito pelo scaffold via source-stamp contribution).
 */
import type { AppTemplateInput, AppWorkspaceFile } from './types.js';

const MAIN_TSX = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

if (import.meta.env.DEV) { import("./mcp-inspector"); }
`;

const APP_TSX = `import { Route, Routes } from 'react-router-dom';
import { SCREENS } from './screens/registry';

/**
 * O App renderiza as rotas a partir do registry de telas — adicione telas
 * em src/screens/registry.ts (nunca hardcode rotas aqui).
 */
export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Routes>
        {SCREENS.map((screen) => (
          <Route key={screen.id} path={screen.path} element={<screen.component />} />
        ))}
      </Routes>
    </div>
  );
}
`;

const REGISTRY_TS = `import type { ComponentType } from 'react';
import { HomeScreen } from './HomeScreen';

export interface ScreenDef {
  /** Id estável da tela (mesmo id da spec — o gate da etapa design confere). */
  id: string;
  path: string;
  /** Título humano exibido na navegação. */
  title: string;
  component: ComponentType;
}

/**
 * Registry de telas — a única fonte das rotas do app. A etapa design
 * substitui/expande estas entradas com as telas da spec aprovada.
 */
export const SCREENS: ScreenDef[] = [
  { id: 'home', path: '/', title: 'Início', component: HomeScreen },
];
`;

function homeScreen(i: AppTemplateInput): string {
  return `import { Sparkles } from 'lucide-react';

/** Tela placeholder — substituída na etapa design pelas telas da spec. */
export function HomeScreen() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <Sparkles className="h-10 w-10 text-primary" />
      <h1 className="text-2xl font-semibold">${i.appName}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Seu app está sendo construído. As telas aparecem aqui conforme as
        etapas avançam.
      </p>
    </main>
  );
}
`;
}

const LIB_API_TS = `/**
 * Client HTTP do app — todas as telas falam com o Worker por aqui
 * (mesma origem: o Vite dev server e o deploy servem SPA + /api juntos).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(\`/api\${path}\`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(body || res.statusText, res.status);
  }
  return (await res.json()) as T;
}
`;

const LIB_MOCK_TS = `/**
 * Dados de exemplo da etapa DESIGN — as telas nascem consumindo este
 * módulo para o preview ter conteúdo realista ANTES do backend existir.
 * A etapa backend troca cada import de lib/mock por lib/api (o gate
 * bloqueia submits com telas ainda em mock).
 */
export const MOCK_READY = true;
`;

export function buildSrcFiles(i: AppTemplateInput): AppWorkspaceFile[] {
  return [
    { path: 'src/main.tsx', contents: MAIN_TSX },
    { path: 'src/App.tsx', contents: APP_TSX },
    { path: 'src/screens/registry.ts', contents: REGISTRY_TS },
    { path: 'src/screens/HomeScreen.tsx', contents: homeScreen(i) },
    { path: 'src/lib/api.ts', contents: LIB_API_TS },
    { path: 'src/lib/mock.ts', contents: LIB_MOCK_TS },
  ];
}
