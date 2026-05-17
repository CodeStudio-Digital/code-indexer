/**
 * Extract the first JSON object or array from an LLM response.
 *
 * Handles three shapes the general-AI model commonly returns:
 *   1. A clean JSON object/array with nothing else around it.
 *   2. JSON wrapped in a ```json fenced block (with optional prose outside).
 *   3. A JSON object/array embedded after some preamble the model chose
 *      to emit despite being asked not to.
 *
 * Returns `null` when no parseable JSON is found. Callers should type-
 * check the returned `unknown` before using it.
 *
 * Shared by every general-AI callsite that asks the model for structured
 * output (git staging suggestions, local-project command synthesis, ...).
 */
export function extractFirstJson(raw: string): unknown {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : raw).trim();
  const openers: Record<string, string> = { '{': '}', '[': ']' };
  for (let i = 0; i < body.length; i++) {
    const open = body[i];
    const close = openers[open];
    if (!close) continue;
    let depth = 0;
    for (let j = i; j < body.length; j++) {
      if (body[j] === open) depth++;
      else if (body[j] === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(body.slice(i, j + 1));
          } catch {
            /* keep scanning */
          }
          break;
        }
      }
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
