/**
 * Best-effort extraction of an API symbol + signature from a documentation
 * heading. Used ONLY for `doc_type='api_reference'` sources, where headings
 * commonly read like a signature:
 *   "Rigidbody.AddForce(Vector3 force, ForceMode mode)" → symbol + signature
 *   "Rigidbody.velocity"                                → symbol only
 *   "useEffect(setup, dependencies?)"                   → symbol + signature
 *
 * Returns nulls when the heading isn't signature-shaped — we never invent
 * structure, so a prose heading stays unannotated. Surfaced on search results
 * + rag_read_doc so an agent can ground code against the exact API shape.
 */

export interface ApiSignature {
  symbol: string | null;
  signature: string | null;
}

const NONE: ApiSignature = { symbol: null, signature: null };

export function extractApiSignature(headingPath: string | null): ApiSignature {
  if (!headingPath) return NONE;
  // Use the deepest heading segment ("Guide > Physics > AddForce(...)" → last).
  const last = headingPath.split('>').pop()?.trim() ?? '';
  if (!last) return NONE;

  // Qualified name immediately followed by a (non-nested) parenthesised arg
  // list. `(?:::…)*` allows multi-level C++ scopes (std::vector::push_back).
  const sig = /^([A-Za-z_$][\w$.]*(?:::[\w$]+)*)\s*(\([^)]*\))/.exec(last);
  if (sig) return { symbol: sig[1]!, signature: `${sig[1]}${sig[2]}` };

  // Dotted/qualified member without parens (property / constant / enum value).
  const member = /^([A-Za-z_$][\w$]*(?:[.#:][\w$]+)+)\s*$/.exec(last);
  if (member) return { symbol: member[1]!, signature: null };

  return NONE;
}
