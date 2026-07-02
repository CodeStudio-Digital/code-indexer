/**
 * Roadmap de componentes do DS Studio — o catálogo shadcn-level (~45 itens)
 * que define a régua de profundidade, mesclado com os candidatos do theme
 * digest: candidato que casa com o catálogo ganha `source:'digest'` +
 * `source_refs` (evidência real no tema); candidato fora do catálogo é
 * anexado no tier sugerido. O PROGRESSO nunca é armazenado — deriva em
 * leitura por name-match contra os componentes registrados do draft.
 */
import type { ThemeDigestComponent } from '../theme-digest/theme-digest.js';

export type DsRoadmapTier = 'primitive' | 'composite' | 'template';

export interface DsRoadmapItem {
  name: string;
  tier: DsRoadmapTier;
  /** 'catalog' = régua padrão; 'digest' = evidenciado no tema importado. */
  source: 'catalog' | 'digest';
  /** `file:line` no tema (só para source:'digest'). */
  source_refs?: string[];
}

export const ROADMAP_PRIMITIVES = [
  'Button', 'IconButton', 'Link', 'Heading', 'Text', 'Label', 'Input', 'Textarea',
  'Select', 'Checkbox', 'Radio', 'Switch', 'Slider', 'Badge', 'Tag', 'Avatar',
  'Tooltip', 'Spinner', 'Progress', 'Skeleton', 'Divider', 'Alert', 'Kbd', 'Icon',
] as const;

export const ROADMAP_COMPOSITES = [
  'Card', 'Dialog', 'Drawer', 'DropdownMenu', 'Tabs', 'Accordion', 'Table',
  'Pagination', 'Breadcrumb', 'Toast', 'FormField', 'Navbar', 'Sidebar',
  'Combobox', 'Stepper', 'Stat', 'EmptyState', 'Footer',
] as const;

/** Templates default do modo criativo; em fidelity as páginas do tema mandam. */
export const ROADMAP_TEMPLATES = ['Dashboard', 'Auth', 'Settings', 'Landing'] as const;

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Sinônimos comuns tema→catálogo (bootstrap-isms e afins). */
const ALIASES: Record<string, string> = {
  btn: 'Button',
  nav: 'Navbar',
  modal: 'Dialog',
  dropdown: 'DropdownMenu',
  form: 'FormField',
  inputgroup: 'FormField',
  toast: 'Toast',
  breadcrumb: 'Breadcrumb',
};

function catalogItems(): DsRoadmapItem[] {
  return [
    ...ROADMAP_PRIMITIVES.map((name): DsRoadmapItem => ({ name, tier: 'primitive', source: 'catalog' })),
    ...ROADMAP_COMPOSITES.map((name): DsRoadmapItem => ({ name, tier: 'composite', source: 'catalog' })),
    ...ROADMAP_TEMPLATES.map((name): DsRoadmapItem => ({ name, tier: 'template', source: 'catalog' })),
  ];
}

function matchCatalog(items: DsRoadmapItem[], candidate: string): DsRoadmapItem | null {
  const norm = normalize(ALIASES[normalize(candidate)] ?? candidate);
  return items.find((item) => normalize(item.name) === norm) ?? null;
}

/**
 * Monta o roadmap da sessão. Sem digest → catálogo puro. Com digest, os
 * candidatos evidenciam itens do catálogo e acrescentam componentes que só
 * o tema tem (Carousel, PricingCard…). Em fidelity as páginas do digest
 * substituem os templates default — o tier vira a réplica das páginas reais.
 */
export function buildRoadmap(opts: {
  mode: 'fidelity' | 'creative';
  digestComponents?: ThemeDigestComponent[] | null;
  digestPages?: Array<{ path: string; title: string | null }> | null;
}): DsRoadmapItem[] {
  let items = catalogItems();

  const candidates = opts.digestComponents ?? [];
  for (const candidate of candidates) {
    const hit = matchCatalog(items, candidate.name);
    if (hit) {
      hit.source = 'digest';
      hit.source_refs = candidate.source_refs.slice(0, 5);
    } else {
      items.push({
        name: candidate.name,
        tier: candidate.suggested_kind === 'page-template' ? 'template' : 'composite',
        source: 'digest',
        source_refs: candidate.source_refs.slice(0, 5),
      });
    }
  }

  if (opts.mode === 'fidelity' && opts.digestPages && opts.digestPages.length > 0) {
    items = items.filter((item) => item.tier !== 'template' || item.source === 'digest');
    for (const page of opts.digestPages) {
      const name = pageTemplateName(page);
      if (!items.some((item) => item.tier === 'template' && normalize(item.name) === normalize(name))) {
        items.push({ name, tier: 'template', source: 'digest', source_refs: [page.path] });
      }
    }
  }
  return items;
}

function pageTemplateName(page: { path: string; title: string | null }): string {
  const base = (page.title?.trim() || page.path.replace(/\.[^.]+$/, '').split('/').pop() || 'Page')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim();
  const pascal = base
    .split(/\s+/)
    .slice(0, 3)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return `${pascal || 'Page'}Template`;
}

/** Progresso derivado: quais itens já têm componente registrado com o mesmo nome. */
export function roadmapProgress(
  roadmap: DsRoadmapItem[],
  recordedNames: string[],
): Array<DsRoadmapItem & { recorded: boolean }> {
  const recorded = new Set(recordedNames.map(normalize));
  return roadmap.map((item) => ({ ...item, recorded: recorded.has(normalize(item.name)) }));
}
