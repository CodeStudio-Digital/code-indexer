/**
 * Hosts supplied by the project workbench. The API client stays mounted in the
 * primary surface and portals its navigator/inspector into the real IDE docks,
 * so request tabs, drafts and responses share one stateful client instance.
 */
export interface ApiClientWorkbenchSlots {
  leftHost: HTMLElement | null;
  rightHost: HTMLElement | null;
  onCloseLeft: () => void;
  onCloseRight: () => void;
}
