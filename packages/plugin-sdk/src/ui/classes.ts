/**
 * The `.mcp-*` class contract the host injects at runtime (see the dashboard's
 * plugin-ui-kit). The CSS bodies live ONLY in the host and are injected into
 * every webview — this module ships the class NAMES so builders and hand-rolled
 * markup reference them with autocomplete + typo-safety, without duplicating CSS.
 *
 * The contract is append-only: the kit never removes or repurposes a class (that
 * would break every installed plugin), so a plugin built against these names
 * keeps rendering under any newer host kit. A cross-package test asserts every
 * value here exists in the host's PLUGIN_UI_KIT_CSS.
 */
export const KIT = {
  app: 'mcp-app',
  // base utilities
  mono: 'mcp-mono',
  muted: 'mcp-muted',
  grow: 'mcp-grow',
  scroll: 'mcp-scroll',
  stack: 'mcp-stack',
  hstack: 'mcp-hstack',
  divider: 'mcp-divider',
  link: 'mcp-link',
  dot: 'mcp-dot',
  // controls
  btn: 'mcp-btn',
  input: 'mcp-input',
  select: 'mcp-select',
  textarea: 'mcp-textarea',
  field: 'mcp-field',
  label: 'mcp-label',
  hint: 'mcp-hint',
  checkbox: 'mcp-checkbox',
  // legacy layout
  toolbar: 'mcp-toolbar',
  card: 'mcp-card',
  list: 'mcp-list',
  row: 'mcp-row',
  tabs: 'mcp-tabs',
  tab: 'mcp-tab',
  badge: 'mcp-badge',
  spinner: 'mcp-spinner',
  loading: 'mcp-loading',
  breadcrumb: 'mcp-breadcrumb',
  crumb: 'mcp-crumb',
  log: 'mcp-log',
  // data layer
  dtable: 'mcp-dtable',
  cellActions: 'mcp-cell-actions',
  rowActions: 'mcp-row-actions',
  status: 'mcp-status',
  shell: 'mcp-shell',
  rail: 'mcp-rail',
  railGroup: 'mcp-rail-group',
  nav: 'mcp-nav',
  navIcon: 'mcp-nav-icon',
  navLabel: 'mcp-nav-label',
  navCount: 'mcp-nav-count',
  content: 'mcp-content',
  detail: 'mcp-detail',
  pageHead: 'mcp-page-head',
  pageBar: 'mcp-page-bar',
  pageTitles: 'mcp-page-titles',
  pageTitle: 'mcp-page-title',
  pageSub: 'mcp-page-sub',
  pageActions: 'mcp-page-actions',
  pageTools: 'mcp-page-tools',
  stats: 'mcp-stats',
  stat: 'mcp-stat',
  statLabel: 'mcp-stat-label',
  statValue: 'mcp-stat-value',
  statDelta: 'mcp-stat-delta',
  state: 'mcp-state',
  stateIcon: 'mcp-state-icon',
  stateTitle: 'mcp-state-title',
  stateMsg: 'mcp-state-msg',
  stateActions: 'mcp-state-actions',
} as const;
