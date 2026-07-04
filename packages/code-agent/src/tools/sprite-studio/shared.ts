/**
 * Shared constants for the `sprite_*` agent tools — the single "not wired"
 * message every handler surfaces when `getGlobalSpriteStudioHost()` is null
 * (headless run, or a project without `.sprite-studio/`).
 */
export const NOT_CONFIGURED =
  'Sprite Studio is not available here. Open a project that has a `.sprite-studio/` ' +
  'directory (initialize the studio from the Sprites view) and make sure the Sprite ' +
  'Studio feature is enabled in Settings.';
