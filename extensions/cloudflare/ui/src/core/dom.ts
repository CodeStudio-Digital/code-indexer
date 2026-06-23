/** Shared DOM helpers + inline icons now come from the SDK UI lib; this thin
 *  re-export keeps existing `../core/dom.js` imports stable. */
export {
  el,
  div,
  button,
  iconButton,
  iconBtn,
  icon,
  input,
  textarea,
  select,
  field,
  clear,
  setChildren,
} from '@mcp/plugin-sdk/ui';
