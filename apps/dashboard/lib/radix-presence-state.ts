export type PresenceState = "mounted" | "unmountSuspended" | "unmounted";

/**
 * A missing node only needs to finish an exit that was already waiting for an
 * animation. Dispatching for mounted or initially unmounted states loops when
 * React 19 replays layout effects while revealing a subtree.
 */
export function shouldFinishUnmountWithoutNode(state: PresenceState): boolean {
  return state === "unmountSuspended";
}
