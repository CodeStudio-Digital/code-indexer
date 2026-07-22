import { createHash } from 'node:crypto';

const EXACT_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SEMVER_PREFIX = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;

export function exactAngularVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = SEMVER_PREFIX.exec(value.trim());
  if (!match || Number(match[1]) < 2) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ?? ''}`;
}

function clauseMajor(rawClause: string): number | null {
  let clause = rawClause.trim();
  if (clause.startsWith('workspace:')) clause = clause.slice('workspace:'.length);
  const npmAlias = /^npm:@angular\/core@(.+)$/.exec(clause);
  if (npmAlias) clause = npmAlias[1]!;
  if (!clause || /^(?:\*|latest|next|file:|link:|git|https?:)/i.test(clause)) return null;

  const exact = EXACT_SEMVER.exec(clause);
  if (exact) return Number(exact[1]) >= 2 ? Number(exact[1]) : null;

  const simple = /^[~^]?\s*v?(\d+)(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/i.exec(clause);
  if (simple) return Number(simple[1]) >= 2 ? Number(simple[1]) : null;

  const hyphen = /v?(\d+)(?:\.\d+){0,2}\s+-\s+v?(\d+)(?:\.\d+){0,2}/.exec(clause);
  if (hyphen) return hyphen[1] === hyphen[2] && Number(hyphen[1]) >= 2 ? Number(hyphen[1]) : null;

  // The common bounded-major form: >=17.0.0 <18.0.0.
  const bounded = />=?\s*v?(\d+)(?:\.\d+){0,2}\s+<\s*v?(\d+)(?:\.\d+){0,2}/.exec(clause);
  if (bounded && Number(bounded[2]) === Number(bounded[1]) + 1 && Number(bounded[1]) >= 2) {
    return Number(bounded[1]);
  }

  // A one-sided comparator spans an unknown number of majors. Do not turn
  // `>=12` or `<20` into a false exact-major signal.
  if ((clause.includes('>') || clause.includes('<'))
    && !(clause.includes('>') && clause.includes('<'))) return null;

  const majors = [...clause.matchAll(/v?(\d+)(?:\.\d+){0,2}/g)].map((match) => Number(match[1]));
  return majors.length > 0 && majors.every((major) => major === majors[0]) && majors[0]! >= 2
    ? majors[0]!
    : null;
}

/** Conservatively returns a major only when every OR branch selects the same one. */
export function singleAngularMajor(spec: unknown): number | null {
  if (typeof spec !== 'string') return null;
  const majors = spec.split('||').map(clauseMajor);
  if (majors.length === 0 || majors.some((major) => major == null)) return null;
  return majors.every((major) => major === majors[0]) ? majors[0] : null;
}

export function angularFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}
