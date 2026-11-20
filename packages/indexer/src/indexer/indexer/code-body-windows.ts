import { slidingWindows } from '@mcp/shared/utils/sliding-window.js';

/** Select at most count windows. Oversized bodies retain the start, middle and end. */
export function sampledStarts(length: number, width: number, count: number): number[] {
  const last = Math.max(0, length - width);
  if (!last || count <= 1) return [0];
  const starts = [0, last];
  while (starts.length < count) {
    let gap = 0, insert = 0;
    for (let i = 1; i < starts.length; i++) {
      const distance = starts[i]! - starts[i - 1]!;
      if (distance > gap) { gap = distance; insert = i; }
    }
    if (gap <= 1) break;
    starts.splice(insert, 0, starts[insert - 1]! + Math.floor(gap / 2));
  }
  return starts;
}

function utf8Excerpt(text: string, limit: number, end: boolean): string {
  const chars = Array.from(end ? text.slice(-limit - 2) : text.slice(0, limit + 2));
  if (end) chars.reverse();
  const kept: string[] = [];
  let bytes = 0;
  for (const ch of chars) {
    bytes += Buffer.byteLength(ch);
    if (bytes > limit) break;
    kept.push(ch);
  }
  return (end ? kept.reverse() : kept).join('');
}

export function codeBodyTexts(body: string, header: string,
  options: { windowChars: number; overlapChars: number; maxChunks: number }): string[] {
  const width = Math.max(1, Math.floor(options.windowChars));
  const count = Math.max(1, Math.floor(options.maxChunks));
  const step = width - Math.max(0, Math.min(width - 1, Math.floor(options.overlapChars)));
  const capped = count >= 2 && body.length > width + (count - 1) * step;
  const windows = capped ? sampledStarts(body.length, width, count).map(start => body.slice(start, start + width))
    : slidingWindows(body, options);
  if (windows.length === 1) return [header + windows[0]];
  return windows.map((window, index) => {
    const part = '(part ' + (index + 1) + '/' + windows.length + ')\n';
    if (!capped) return header + part + window;
    // Put a bounded excerpt first so the model's 512-token input actually sees
    // the chosen location, including the last line of a large symbol.
    const last = index === windows.length - 1;
    const middle = Math.floor(window.length / 2);
    const from = last || index === 0 ? 0 : middle - utf8Excerpt(window.slice(0, middle), 152, true).length;
    const excerpt = utf8Excerpt(window.slice(from), 304, last);
    const context = utf8Excerpt(header, 160, false);
    return context + part + excerpt + '\n---\n' + (last ? window.slice(0, -excerpt.length) : window.slice(0, from) + window.slice(from + excerpt.length));
  });
}
