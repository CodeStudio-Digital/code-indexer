/**
 * Remove isolated UTF-16 surrogate code units introduced by a character
 * budget boundary. JavaScript strings are indexed by code unit, so a plain
 * `slice()` can otherwise split an astral character and providers serialize
 * the orphan as U+FFFD.
 */
export function stripUnpairedSurrogates(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i += 1;
      }
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) continue;
    out += value[i];
  }
  return out;
}
