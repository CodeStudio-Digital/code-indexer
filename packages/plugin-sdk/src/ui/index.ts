/**
 * @mcp/plugin-sdk/ui — the polished, framework-agnostic UI library for plugin
 * webviews. Vanilla TS over the host-injected `.mcp-*` kit (the host's React
 * components can't run in a null-origin iframe). Import these instead of
 * hand-rolling DOM/CSS so plugins look native and consistent.
 *
 *   import { masterDetail, pageHeader, dataTable, status, icon } from '@mcp/plugin-sdk/ui';
 *
 * The kit CSS is injected at runtime by the host and is an append-only `.mcp-*`
 * contract — never bundle or vendor it. `KIT` exposes the class names; call
 * `configureKitLabels` once at boot to localize the builders' built-in strings.
 */
export { mcp } from './mcp.js';
export type {
  ToolResult,
  StreamChunk,
  StreamHandlers,
  ModelOption,
  AssistantChunk,
  AssistantHandlers,
  Mcp,
} from './mcp.js';

export { ICONS } from './icons.js';
export type { IconName } from './icons.js';
export { KIT } from './classes.js';
export { configureKitLabels, kitLabel } from './labels.js';
export type { KitLabels } from './labels.js';

export {
  el,
  div,
  icon,
  button,
  iconBtn,
  iconButton,
  input,
  textarea,
  select,
  field,
  clear,
  setChildren,
} from './dom.js';

export {
  call,
  rowsOf,
  detailsOf,
  toast,
  errorMessage,
  confirmDanger,
  mutate,
  parseJsonOr,
} from './api.js';
export type { Row } from './api.js';

export { state, loadingBox, emptyBox, errorBox, jsonPre } from './states.js';
export type { StateSpec } from './states.js';

export { dataTable, autoTable, status } from './table.js';
export type { Column, RowAction, TableSpec, StatusKind } from './table.js';

export { masterDetail, navRail, pageHeader, statTiles, tabsBar } from './layout.js';
export type { NavItem, MasterDetailSpec, HeaderAction, PageHeaderSpec, Stat } from './layout.js';

export { listView, detailHeader, invalidateRows } from './list.js';
export type { ListSpec } from './list.js';

export { streamLog } from './stream.js';
export type { StreamLog } from './stream.js';
