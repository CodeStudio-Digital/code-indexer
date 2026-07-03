/**
 * Some provider model strings carry a mode suffix encoded by the dashboard,
 * e.g. `"glm-5.1::coding"`. This helper splits the bare model id from the
 * mode so vendor-facing code sees a clean id.
 *
 * Treats empty string and `undefined` identically — the dashboard sends
 * `model: ""` when the user picked a provider but left the model blank,
 * and the naive `?? default` further down wouldn't catch that (it would
 * pass the empty string straight to the vendor API for a silent 400).
 */
export interface ParsedModelMode {
  model: string | undefined;
  mode: string | undefined;
}

export function parseModelWithMode(raw: string | undefined): ParsedModelMode {
  if (!raw) return { model: undefined, mode: undefined };
  const idx = raw.indexOf('::');
  if (idx === -1) return { model: raw || undefined, mode: undefined };
  return {
    model: raw.slice(0, idx) || undefined,
    mode: raw.slice(idx + 2) || undefined,
  };
}
