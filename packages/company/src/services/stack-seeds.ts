/**
 * Stack-specific snapshot seeds for builder-mode sessions.
 *
 * Each builder session gets these snapshots inserted into its project(s)
 * so the master agent can retrieve stack conventions via the MCP
 * `query_snapshots` tool (hybrid FTS+vector search). The content reflects
 * idiomatic 2026 patterns (React 19.2, Vue 3.5+, Angular 19+) and is meant
 * to OVERRIDE any older conventions the LLM may have internalized from
 * training data.
 *
 * Versioning: bump `SEED_VERSION` when the content materially changes so
 * the seeder knows to re-run (idempotency key is
 * `stack:<stack>@v<SEED_VERSION>` stored in tags).
 */

import type { SnapshotCategory } from '@mcp/shared/types.js';
import type { BuilderStack } from '@mcp/services/sandbox/types.js';

export const SEED_VERSION = 1;

export interface SeedDoc {
  title: string;
  category: SnapshotCategory;
  content: string;
  extraTags?: string[];
}

// ─────────────────────────────────────────────────────────────────────────
//  React + Vite + TypeScript
// ─────────────────────────────────────────────────────────────────────────

const REACT_SEEDS: SeedDoc[] = [
  {
    title: 'Stack & versions — React + Vite + TS',
    category: 'architecture',
    content: `Modern React stack (April 2026):

- **Vite 8.x** (latest stable). SWC-based React plugin for fastest HMR.
- **React 19.2.x**. Nativo: Actions, \`useActionState\`, \`useFormStatus\`,
  \`useOptimistic\`, \`use()\` (for promises/contexts), React Compiler.
- **TypeScript 5.6+** strict mode. No \`any\`.
- **Tailwind CSS v4.x** (Lightning CSS engine, Rust). CSS-first config —
  NO \`tailwind.config.js\` required.
- **shadcn/ui v4** — copy-paste components under \`src/components/ui/\`.
  Default style: "New York". Base color: Zinc or Slate.

### Path alias

Always set \`@/*\` → \`./src/*\` in both \`tsconfig.json\` (and
\`tsconfig.app.json\`) and in \`vite.config.ts\`. shadcn/ui depends on this.`,
    extraTags: ['versions'],
  },
  {
    title: 'Project layout & naming — React + Vite + TS',
    category: 'convention',
    content: `Folder structure:

- \`src/main.tsx\` — entry point; mounts \`<App />\` with \`StrictMode\`.
- \`src/App.tsx\` — root component.
- \`src/components/ui/\` — shadcn primitives (Button, Input, Card, Form, …).
- \`src/components/\` — app-specific composite components.
- \`src/lib/utils.ts\` — the shadcn-required \`cn()\` helper.
- \`src/hooks/\` — custom hooks (prefixed \`use*\`).
- \`src/pages/\` or \`src/routes/\` — page-level components when routing added.
- \`src/index.css\` — Tailwind v4 entry (\`@import "tailwindcss"\` + theme).

Naming:

- Components: \`PascalCase.tsx\` (one component per file).
- Hooks: \`useCamelCase.ts\`.
- Utilities: \`camelCase.ts\`.
- Types: \`PascalCase\` with \`Props\` / \`Type\` suffix where appropriate.
- Constants: \`SCREAMING_SNAKE_CASE\`.`,
    extraTags: ['layout', 'naming'],
  },
  {
    title: 'Styling — Tailwind v4 + shadcn/ui v4',
    category: 'convention',
    content: `Tailwind v4 is CSS-first. The \`src/index.css\` looks like:

\`\`\`css
@import "tailwindcss";

@theme {
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* …shadcn tokens… */
}

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    /* … */
  }
  .dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    /* … */
  }
}
\`\`\`

### shadcn/ui v4

Install components on demand:

\`\`\`bash
npx shadcn@latest add button input label card form
\`\`\`

Components land under \`src/components/ui/\` and are YOURS — edit freely
to match the product design system (border-radius, transitions, hover).
Do NOT wrap them in HOC layers; extend via props / compose directly.`,
    extraTags: ['styling', 'tailwind', 'shadcn'],
  },
  {
    title: 'Data & forms — idiomatic React 19',
    category: 'pattern',
    content: `### Forms: prefer \`<form action>\` + \`useActionState\`

\`\`\`tsx
import { useActionState } from "react";

async function loginAction(prev: State | null, formData: FormData) {
  const email = formData.get("email");
  // mutate, then return next state
  return { success: true, message: "OK" };
}

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(loginAction, null);
  return (
    <form action={formAction} className="space-y-4">
      <Input name="email" type="email" required />
      <Button type="submit" disabled={isPending}>
        {isPending ? "…" : "Entrar"}
      </Button>
    </form>
  );
}
\`\`\`

### Async data: \`use(promise)\` + \`<Suspense>\`

Pass Promises as props down from a data-loading boundary; resolve with
\`use()\` in the leaf component. Combine with \`<Suspense fallback>\` for
loading UI. Prefer this over \`useEffect\` + \`useState\` for fetch.

### Optimistic mutations: \`useOptimistic\`

Wrap the mutation call with \`useOptimistic(current, reducer)\` to update
the UI immediately while the server action is in flight.

### Avoid

- \`useEffect\` for data fetching (use \`use()\` or actions).
- \`useEffect\` + \`onSubmit\` for form submission (use \`action={fn}\`).
- Manual loading state (use \`useFormStatus\` / \`isPending\`).`,
    extraTags: ['forms', 'actions', 'suspense'],
  },
  {
    title: 'Memoization — React Compiler rules',
    category: 'pattern',
    content: `If the React Compiler is active (recommended for new React 19
projects via \`babel-plugin-react-compiler\`), **do NOT** write
\`useMemo\`, \`useCallback\`, or \`React.memo\` by hand — the compiler
handles memoization automatically and manual wrappers can actually
degrade it.

Write idiomatic code:

\`\`\`tsx
export function UserList({ users, filter }: Props) {
  const filtered = users.filter(u => u.name.includes(filter));  // OK
  const handleClick = (id: string) => console.log(id);          // OK
  return <>{filtered.map(u => <UserRow key={u.id} onClick={handleClick} />)}</>;
}
\`\`\`

Only reach for \`useMemo\`/\`useCallback\` when:

1. The Compiler is NOT enabled in this project, AND
2. Profiling shows a real measurable regression.

If you see pre-existing \`useMemo\`/\`useCallback\` that guard trivial
values (numbers, strings, simple objects), you may remove them when
touching that code — but leave a one-line comment explaining why.`,
    extraTags: ['react-compiler', 'perf'],
  },
  {
    title: 'Sandbox reserved files — React/Vite',
    category: 'note',
    content: `DO NOT MODIFY \`vite.config.ts\` in the builder sandbox. It is
regenerated on every session start by the MCP SandboxService and contains
proxy-specific settings (\`base\`, \`server.host: '0.0.0.0'\`,
\`server.watch.usePolling\`, \`server.hmr\`) that, if changed, BREAK the
preview iframe (ECONNREFUSED at the proxy) and HMR.

If you need app-level Vite customization (aliases, extra plugins), create
a NEW file \`vite.user.config.ts\` and merge it — never overwrite the
managed one.

The dev server (Vite) is already running on port 5173 inside the
container. Never run \`npm run dev\` yourself; just write code and HMR
picks up the change.`,
    extraTags: ['sandbox', 'reserved'],
  },
];

// ─────────────────────────────────────────────────────────────────────────
//  Vue 3 + Vite + TypeScript
// ─────────────────────────────────────────────────────────────────────────

const VUE_SEEDS: SeedDoc[] = [
  {
    title: 'Stack & versions — Vue + Vite + TS',
    category: 'architecture',
    content: `Modern Vue stack (April 2026):

- **Vite 8.x** (latest). Official \`@vitejs/plugin-vue\` with Vue 3.5+.
- **Vue 3.5.x**. Composition API with \`<script setup>\` is the DEFAULT;
  Options API only for legacy migrations. Key additions:
  - \`defineModel()\` (v3.4+) — replaces manual \`props + emit('update:…')\`.
  - Generic components via \`<script setup lang="ts" generic="T">\`.
  - Reactive Props Destructure (stable).
  - \`useTemplateRef()\` for template refs.
- **TypeScript 5.6+** strict. Use \`vue-tsc\` for type-check of \`.vue\`.
- **Pinia 2.x** for state management (NOT Vuex).
- **Vue Router 4.x**.
- **Tailwind CSS v4.x** (CSS-first, same as React stack).
- **shadcn-vue** — port of shadcn/ui for Vue; copy-paste components.

### Path alias

\`@/*\` → \`./src/*\` in \`tsconfig.json\` + \`vite.config.ts\`.`,
    extraTags: ['versions'],
  },
  {
    title: 'Project layout & naming — Vue + Vite + TS',
    category: 'convention',
    content: `Folder structure:

- \`src/main.ts\` — entry; creates app, mounts \`#app\`, \`use()\` Pinia/Router.
- \`src/App.vue\` — root component (\`<script setup lang="ts">\`).
- \`src/components/ui/\` — shadcn-vue primitives.
- \`src/components/\` — app-specific \`.vue\` SFCs.
- \`src/composables/\` — composition functions (\`useCamelCase.ts\`).
- \`src/stores/\` — Pinia stores (\`useCamelCaseStore.ts\`, setup-style).
- \`src/router/index.ts\` — route definitions.
- \`src/views/\` — page-level components.
- \`src/lib/utils.ts\` — \`cn()\` helper (shadcn-vue requires it).
- \`src/style.css\` — Tailwind v4 entry + CSS vars.

Naming:

- Components: \`PascalCase.vue\` (multi-word). Single-word names are OK for
  leaves when unambiguous (Vue recommends two words for HTML-conflict
  avoidance — \`BaseButton\`, not \`Button\`).
- Composables: \`useSomething.ts\`.
- Stores: \`useSomethingStore.ts\`.
- Props typing: \`interface Props { … }\` + \`defineProps<Props>()\`.`,
    extraTags: ['layout', 'naming'],
  },
  {
    title: 'Styling — Tailwind v4 + shadcn-vue',
    category: 'convention',
    content: `Tailwind v4 config lives in CSS (not \`tailwind.config.js\`):

\`\`\`css
@import "tailwindcss";

@theme {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* … */
}

@layer base {
  :root { --background: 0 0% 100%; --foreground: 240 10% 3.9%; }
  .dark { --background: 240 10% 3.9%; --foreground: 0 0% 98%; }
}
\`\`\`

### shadcn-vue

\`\`\`bash
npx shadcn-vue@latest init
npx shadcn-vue@latest add Button Input Label Card Form
\`\`\`

Components are written as Vue SFCs under \`src/components/ui/\`. They're
yours — edit freely. Use \`:class\` binding with \`cn()\` for variants.`,
    extraTags: ['styling', 'tailwind', 'shadcn-vue'],
  },
  {
    title: 'Data & forms — idiomatic Vue 3.5',
    category: 'pattern',
    content: `### Components: \`<script setup lang="ts">\` + generics

\`\`\`vue
<script setup lang="ts" generic="T extends { id: string }">
interface Props { items: T[]; label?: string }
const props = defineProps<Props>();
const emit = defineEmits<{ select: [id: string] }>();
const selected = defineModel<string>();  // two-way binding, v3.4+
</script>

<template>
  <div>
    <button v-for="it in items" :key="it.id" @click="selected = it.id">
      {{ label ?? it.id }}
    </button>
  </div>
</template>
\`\`\`

### Reactivity

- \`ref()\` for primitives and re-assignable references.
- \`reactive()\` for objects (but prefer \`ref\` for consistency — destructuring
  a \`reactive\` loses reactivity; \`ref\` is safer).
- \`computed()\` for derived values.
- \`watch\` / \`watchEffect\` sparingly — prefer \`computed\`.
- \`toRefs(props)\` ONLY when you need to destructure; with Reactive Props
  Destructure enabled (default in 3.5), plain destructure works.

### Async data

Use \`<Suspense>\` + top-level \`await\` in \`<script setup>\`, or the
\`asyncData\` pattern from Nuxt-style composables:

\`\`\`vue
<script setup lang="ts">
const user = await $fetch(\`/api/user/\${id}\`);
</script>
\`\`\`

### Forms

Prefer native \`<form @submit.prevent="handler">\` with a composable
\`useForm()\` or VeeValidate 4 + Zod. Avoid jQuery-style imperative code.`,
    extraTags: ['forms', 'composition', 'generics'],
  },
  {
    title: 'State management — Pinia 2 setup stores',
    category: 'pattern',
    content: `Use the **setup store** syntax (not options store):

\`\`\`ts
// src/stores/useUserStore.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useUserStore = defineStore('user', () => {
  const name = ref('');
  const items = ref<string[]>([]);
  const count = computed(() => items.value.length);

  function addItem(x: string) { items.value.push(x); }

  return { name, items, count, addItem };
});
\`\`\`

- Never mutate state outside actions of the store.
- For async, \`async function\` inside the setup store is idiomatic.
- Use \`storeToRefs(store)\` when destructuring reactive state in components.

Lazy routes + stores are automatically code-split by Vite — no manual
chunking needed.`,
    extraTags: ['state', 'pinia'],
  },
  {
    title: 'Sandbox reserved files — Vue/Vite',
    category: 'note',
    content: `DO NOT MODIFY \`vite.config.ts\` in the builder sandbox. It is
regenerated on every session start by the MCP SandboxService and contains
proxy-specific settings (\`base\`, \`server.host: '0.0.0.0'\`,
\`server.watch.usePolling\`, \`server.hmr\`). Changing it BREAKS the preview
iframe and HMR.

For app-level Vite customization, create a NEW \`vite.user.config.ts\` and
merge — never overwrite the managed file.

Vite is already running on port 5173 in the container. Do NOT run
\`npm run dev\`; just write code and HMR handles the rest.`,
    extraTags: ['sandbox', 'reserved'],
  },
];

// ─────────────────────────────────────────────────────────────────────────
//  Angular 19+
// ─────────────────────────────────────────────────────────────────────────

const ANGULAR_SEEDS: SeedDoc[] = [
  {
    title: 'Stack & versions — Angular 19',
    category: 'architecture',
    content: `Modern Angular stack (April 2026):

- **Angular 19.x**. Uses the new **application builder** (esbuild + Vite
  dev server under the hood) by default.
- **Standalone components by default** — no \`NgModule\` for new code.
  \`standalone: true\` is implicit from v19.
- **Signals** are the primary reactivity primitive:
  \`signal\`, \`computed\`, \`effect\`, \`input()\`, \`output()\`, \`model()\`,
  and new \`httpResource()\` / \`resource()\` for async data.
- **Control-flow syntax** (\`@if\`, \`@for\`, \`@switch\`) — NOT \`*ngIf\` /
  \`*ngFor\`. Migrate legacy directives eagerly.
- **inject()** for DI in functions/constructors; no constructor injection.
- **TypeScript 5.6+ strict**.
- **RxJS 7.x** — still used for HTTP + streams, but signals for state.

### UI libraries

- **spartan-ng** (\`@spartan-ng/ui\`) — shadcn-like copy-paste primitives
  built on CDK + Tailwind.
- **Angular Material 19** as a full-framework alternative.
- **Tailwind CSS v4.x** — same CSS-first config as React/Vue.`,
    extraTags: ['versions'],
  },
  {
    title: 'Project layout & naming — Angular 19',
    category: 'convention',
    content: `Folder structure (generated by \`ng new\` with routing):

- \`src/main.ts\` — \`bootstrapApplication(AppComponent, appConfig)\`.
- \`src/app/app.component.ts\` — root standalone component.
- \`src/app/app.config.ts\` — \`providers: [provideRouter, provideHttpClient, …]\`.
- \`src/app/app.routes.ts\` — route definitions with \`loadComponent\`.
- \`src/app/features/<feature>/\` — feature folders (pages, child routes,
  services scoped to the feature).
- \`src/app/shared/ui/\` — reusable UI components (spartan-ng wrappers).
- \`src/app/core/\` — app-wide singletons (services, interceptors, guards).

Naming (Angular style guide 2026, \`.component\`/\`.service\` suffix optional
from v20 but still idiomatic):

- Components: \`kebab-case.component.ts\`, exported class \`PascalCaseComponent\`.
- Services: \`kebab-case.service.ts\`, \`@Injectable({ providedIn: 'root' })\`.
- Signals inside a component: plain camelCase (\`count = signal(0)\`).
- Inputs/outputs: use \`input()\` / \`output()\` signal APIs (not decorators).`,
    extraTags: ['layout', 'naming'],
  },
  {
    title: 'Styling — Tailwind v4 + spartan-ng',
    category: 'convention',
    content: `Tailwind v4 setup in \`src/styles.css\`:

\`\`\`css
@import "tailwindcss";

@theme {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  /* … */
}

@layer base {
  :root { --background: 0 0% 100%; --foreground: 240 10% 3.9%; }
  .dark { --background: 240 10% 3.9%; --foreground: 0 0% 98%; }
}
\`\`\`

Ensure \`angular.json > projects.*.architect.build.options.styles\` includes
\`src/styles.css\` (default). No PostCSS config needed — the application
builder handles it via Lightning CSS.

### spartan-ng

\`\`\`bash
npx ng add @spartan-ng/cli
npx ng g @spartan-ng/cli:ui button
\`\`\`

Components are generated under \`src/app/shared/ui/\` as standalone
components — yours to edit.

### @angular/animations

For motion, import only what you use:

\`\`\`ts
providers: [provideAnimationsAsync()]
\`\`\`

Avoid the full \`BrowserAnimationsModule\` legacy path.`,
    extraTags: ['styling', 'tailwind', 'spartan'],
  },
  {
    title: 'Data & reactivity — Angular 19 signals + control flow',
    category: 'pattern',
    content: `### Signals replace \`@Input\`/\`@Output\` and most \`BehaviorSubject\` uses

\`\`\`ts
import { Component, signal, computed, input, output, model } from '@angular/core';

@Component({
  selector: 'app-counter',
  template: \`
    <button (click)="inc()">+</button>
    <span>{{ count() }}</span>
    <span>double: {{ double() }}</span>
  \`,
})
export class CounterComponent {
  step = input(1);                       // <app-counter [step]="3" />
  changed = output<number>();            // (changed)="..."
  value = model(0);                      // two-way [(value)]

  count = signal(0);
  double = computed(() => this.count() * 2);

  inc() {
    this.count.update(n => n + this.step());
    this.changed.emit(this.count());
  }
}
\`\`\`

### Control flow — use the block syntax

\`\`\`html
@if (user(); as u) {
  <p>Hi {{ u.name }}</p>
} @else {
  <p>Guest</p>
}

@for (item of items(); track item.id) {
  <li>{{ item.name }}</li>
} @empty {
  <p>Empty</p>
}

@switch (status()) {
  @case ('loading') { <spinner /> }
  @case ('error')   { <err /> }
  @default          { <content /> }
}
\`\`\`

\`*ngIf\` / \`*ngFor\` / \`*ngSwitch\` are deprecated for new code — migrate
eagerly with \`ng generate @angular/core:control-flow\`.

### Async data

- **\`httpResource\`** (v19+): signal-aware HTTP reactive resource.
  \`const user = httpResource(() => \`/api/users/\${id()}\`)\` —
  returns a signal with \`value\`, \`isLoading\`, \`error\`.
- **\`resource\`**: same shape for arbitrary async functions.
- RxJS Observables still valid for streams / complex flows; \`toSignal()\`
  bridges them into templates.

### Forms

Prefer **Typed Reactive Forms**:

\`\`\`ts
form = new FormGroup({
  email: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  password: new FormControl('', { nonNullable: true }),
});
\`\`\`

Template-driven forms only for trivial cases.`,
    extraTags: ['signals', 'control-flow', 'forms'],
  },
  {
    title: 'Routing & DI — Angular 19',
    category: 'pattern',
    content: `### Router: lazy via \`loadComponent\`

\`\`\`ts
// app.routes.ts
export const routes: Routes = [
  { path: '', loadComponent: () => import('./home/home.component').then(m => m.HomeComponent) },
  {
    path: 'users',
    loadChildren: () => import('./users/users.routes').then(m => m.USER_ROUTES),
  },
];

// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideAnimationsAsync(),
  ],
};
\`\`\`

### DI: \`inject()\` over constructor params

\`\`\`ts
export class UserService {
  private http = inject(HttpClient);
  private router = inject(Router);
}
\`\`\`

Functional interceptors, guards, and resolvers are preferred:

\`\`\`ts
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isLoggedIn() || inject(Router).createUrlTree(['/login']);
};
\`\`\`

### State stores

Small apps: signal-based services with \`@Injectable({ providedIn: 'root' })\`.
Large apps: NgRx SignalStore (NOT classic NgRx — too much boilerplate).`,
    extraTags: ['routing', 'di'],
  },
  {
    title: 'Sandbox reserved files — Angular',
    category: 'note',
    content: `DO NOT MODIFY the \`projects.*.architect.serve.options\` block
in \`angular.json\` inside the builder sandbox. It is set by the MCP
SandboxService with proxy-aware values (\`host\`, \`port\`, \`allowedHosts\`,
\`servePath\`, \`poll\`). Changing them BREAKS the preview iframe and the
file watcher.

You MAY edit the \`build.options\` block (styles, assets, scripts) freely.

The dev server (\`ng serve\`) is already running inside the container on
the configured port. Do NOT run \`ng serve\` yourself; just edit code and
the watcher picks up the change.`,
    extraTags: ['sandbox', 'reserved'],
  },
];

// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
//  API stacks — minimal seeds. Agents working on these services rely
//  mostly on the Hono and Cloudflare Workers runtime knowledge already
//  present in the model; the seeds here document only the sandbox-
//  specific constraints (managed files, dev-server flags) that aren't
//  in the training data.
// ─────────────────────────────────────────────────────────────────────────

const VITE_API_SEEDS: SeedDoc[] = [
  {
    title: 'Stack & versions — Hono + Vite API',
    category: 'architecture',
    content: `Hono API served by Vite dev-server (April 2026):

- **Hono 4.12.x** — Web Fetch API-based router. The same \`app\` export
  runs on Node, Cloudflare Workers, Deno, Bun, Vercel Edge.
- **@hono/vite-dev-server 0.25.x** — Vite plugin that calls \`app.fetch\`
  per request, giving you real Vite HMR on backend route changes.
- **Vite 8.x** — dev server and production bundler (\`vite build --ssr\`).
- **TypeScript 5.9.x**.

Entry point: \`src/index.ts\` exports \`default app\` (a Hono instance).
Never add a \`app.listen(...)\`/\`serve(...)\` call there — the plugin
handles binding; a manual listen would collide with Vite's port.`,
    extraTags: ['sandbox', 'stack'],
  },
  {
    title: 'Reserved files — vite.config.ts',
    category: 'architecture',
    content: `\`vite.config.ts\` is managed by the sandbox service. It
wires the \`devServer\` plugin with \`entry: 'src/index.ts'\` and the
proxy-aware \`base\`/\`hmr\` settings. Do NOT overwrite it — add plugins
or aliases in a NEW file (e.g. \`vite.user.config.ts\`) and import from
it if needed.`,
    extraTags: ['sandbox', 'reserved'],
  },
];

const CF_WORKER_SEEDS: SeedDoc[] = [
  {
    title: 'Stack & versions — Cloudflare Worker',
    category: 'architecture',
    content: `Cloudflare Worker with Hono (April 2026):

- **wrangler 4.83.x** — runs under the local \`workerd\` runtime so dev
  is byte-compatible with production.
- **Hono 4.12.x** — \`Hono<{ Bindings }>\`; the \`Bindings\` generic
  types your KV/D1/R2/Queue/Durable Object bindings.
- **@cloudflare/workers-types 4.202604xx** — runtime types.
- **TypeScript 5.9.x**.

Entry: \`src/index.ts\` exports \`default app\` (a Hono instance).
Configuration lives in \`wrangler.toml\`. Bindings added there must
be mirrored in the \`Bindings\` type.`,
    extraTags: ['sandbox', 'stack'],
  },
  {
    title: 'Reserved files — wrangler.toml [dev] block',
    category: 'architecture',
    content: `\`wrangler.toml\` \`name\`, \`main\`, and the whole \`[dev]\`
block are managed by the sandbox service. You can freely add bindings
(\`[[kv_namespaces]]\`, \`[[d1_databases]]\`, \`[vars]\`, etc.) but
don't change the dev port or ip — the preview proxy depends on them.`,
    extraTags: ['sandbox', 'reserved'],
  },
];

export const STACK_SEEDS: Record<BuilderStack, SeedDoc[]> = {
  'react-ts': REACT_SEEDS,
  'vue-ts': VUE_SEEDS,
  angular: ANGULAR_SEEDS,
  'vite-api': VITE_API_SEEDS,
  'cf-worker': CF_WORKER_SEEDS,
};

export function stackVersionTag(stack: BuilderStack): string {
  return `stack:${stack}@v${SEED_VERSION}`;
}
