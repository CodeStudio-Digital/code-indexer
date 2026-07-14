/**
 * AppSpec — o documento de requisitos aprovado de um projeto App Studio,
 * produzido durante Definir via tool `app_save_spec` e versionado quando o
 * usuário aprova o Escopo. Serializado em
 * `app_studio_sessions.spec_json` (canônico) + espelho legível em
 * `spec/app-spec.json` no workspace.
 *
 * Convenção de nomes: `name` é o identificador de CÓDIGO (snake_case p/
 * entities/fields, kebab p/ screen ids); `label` é o nome HUMANO no idioma
 * do usuário (alimenta o painel "Seus dados" e a UI do app gerado). O
 * schema é versionado AQUI (v1) — mudanças de shape exigem bump + parse
 * tolerante.
 */

export type AppFieldType = 'text' | 'integer' | 'real' | 'timestamp';

export interface AppSpecField {
  /** Identificador de código (snake_case), vira coluna. */
  name: string;
  /** Nome humano no idioma do usuário ("Nome do cliente"). */
  label: string;
  type: AppFieldType;
  required?: boolean;
  /** Nome da entity referenciada (FK lógica). */
  references?: string;
}

export interface AppSpecEntity {
  /** Identificador de código (snake_case), vira tabela. */
  name: string;
  /** Nome humano ("Pedidos"). */
  label: string;
  fields: AppSpecField[];
}

export interface AppSpecScreen {
  /** Id estável (kebab-case) — referenciado por features/auth e pelo registry de telas. */
  id: string;
  /** Nome de componente (PascalCase) — vira o arquivo em src/screens/. */
  name: string;
  /** Nome humano ("Painel de pedidos"). */
  label: string;
  purpose: string;
  /** Tela inicial do app (rota /). */
  primary?: boolean;
}

export interface AppSpecFeature {
  id: string;
  name: string;
  description: string;
  /** Telas onde a feature aparece (pode ser vazio p/ features só-API). */
  screen_ids: string[];
}

/**
 * Comportamento (nó de fluxo do Blueprint): gatilho numa tela → ações em
 * ordem. NÃO compila código — é instrução estruturada que o AGENTE
 * implementa e verifica na fatia vertical ligada às mesmas fontes.
 */
export type AppBehaviorTrigger = 'click' | 'submit' | 'open';

export type AppBehaviorAction =
  | { kind: 'save'; entity: string }
  | { kind: 'navigate'; screen_id: string }
  | { kind: 'notify'; message: string };

export interface AppBehavior {
  /** Id estável (kebab-case), único. */
  id: string;
  /** Tela onde o gatilho vive. */
  screen_id: string;
  trigger: AppBehaviorTrigger;
  /** Descrição humana do gatilho ("ao clicar em 'Salvar pedido'"). */
  trigger_label: string;
  /** ≥1, executadas em ordem. */
  actions: AppBehaviorAction[];
}

export type AppAuthMethod = 'password' | 'oauth-google' | 'oauth-github';

export interface AppSpecAuth {
  enabled: boolean;
  methods?: AppAuthMethod[];
  /** Telas que exigem login. */
  protected_screen_ids?: string[];
}

export interface AppSpecDatabase {
  required: boolean;
  entities: AppSpecEntity[];
}

/**
 * Requisitos de produto em linguagem humana. São opcionais por compatibilidade
 * com specs antigas, mas usados pelo painel/assistente para refinar o plano
 * antes do build.
 */
export interface AppSpecRequirements {
  /** Objetivos que o app precisa cumprir. */
  goals?: string[];
  /** Regras de negócio que não são apenas telas ou campos. */
  business_rules?: string[];
  /** Critérios objetivos para o usuário aprovar que está pronto. */
  acceptance_criteria?: string[];
  /** O que explicitamente não entra nesta versão. */
  out_of_scope?: string[];
  /** Suposições feitas enquanto o usuário não confirmou detalhes. */
  assumptions?: string[];
  /** Riscos, dúvidas ou pontos que precisam de atenção no build. */
  risks?: string[];
}

export interface AppSpec {
  v: 1 | 2;
  /** Uma frase: o que o app faz. */
  summary: string;
  audience: string;
  /** Idioma do usuário (ex: 'pt-BR') — dirige os textos do APP gerado. */
  locale: string;
  features: AppSpecFeature[];
  screens: AppSpecScreen[];
  database: AppSpecDatabase;
  auth: AppSpecAuth;
  design: { tone: string; primary_color?: string };
  integrations?: { r2?: boolean };
  /** Requisitos refinados do produto (opcional; specs antigas podem não ter). */
  requirements?: AppSpecRequirements;
  /** IDs paralelos e estáveis introduzidos no v2; v1 é normalizado por hash. */
  requirement_ids?: Partial<Record<'goal' | 'rule' | 'acceptance' | 'out-of-scope' | 'assumption' | 'risk', string[]>>;
  /** Nós de fluxo do Blueprint (opcional; ausente = sem comportamentos declarados). */
  behaviors?: AppBehavior[];
}

export function parseAppSpec(json: string | null | undefined): AppSpec | null {
  if (!json) return null;
  try {
    const spec = JSON.parse(json) as AppSpec;
    if ((spec?.v !== 1 && spec?.v !== 2) || !Array.isArray(spec.screens)) return null;
    return spec;
  } catch {
    return null;
  }
}

export function serializeAppSpec(spec: AppSpec): string {
  return JSON.stringify(spec, null, 2);
}
