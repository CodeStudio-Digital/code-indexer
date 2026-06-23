/** The tool-call layer (call/mutate/toast/…) now lives in the SDK UI lib; its
 *  built-in strings are localized via configureKitLabels in core/i18n.ts. This
 *  thin re-export keeps existing `../core/api.js` imports stable. */
export {
  call,
  rowsOf,
  detailsOf,
  toast,
  errorMessage,
  confirmDanger,
  mutate,
  parseJsonOr,
} from '@mcp/plugin-sdk/ui';
export type { Row } from '@mcp/plugin-sdk/ui';
