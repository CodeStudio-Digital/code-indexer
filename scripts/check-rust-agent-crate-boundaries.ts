#!/usr/bin/env tsx
/**
 * Fail-closed architecture gate for the native agent workspace.
 *
 * Every workspace crate and every local dependency edge must be listed here.
 * Adding a crate or widening an edge therefore requires an explicit review of
 * this policy instead of silently changing the runtime's dependency graph.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const RUNTIME_ROOT = join(REPO_ROOT, 'native', 'agent-runtime');
const ROOT_MANIFEST = join(RUNTIME_ROOT, 'Cargo.toml');
const SUPERVISOR_SOURCE_ROOT = join(
  RUNTIME_ROOT,
  'crates',
  'agentd-supervisor',
  'src',
);
const CANONICAL_SUPERVISOR_SPAWN_EFFECT =
  'crates/agentd-supervisor/src/process_table/operations/spawn.rs';

interface CrateRule {
  name: string;
  allowedInternalDependencies: readonly string[];
}

const CRATE_RULES: Readonly<Record<string, CrateRule>> = {
  'crates/agent-engine': {
    name: 'agent-engine',
    allowedInternalDependencies: ['agent-tools'],
  },
  'crates/agent-host-bridge': {
    name: 'agent-host-bridge',
    allowedInternalDependencies: ['agent-platform', 'agent-protocol'],
  },
  'crates/agent-host-bridge-napi': {
    name: 'agent-host-bridge-napi',
    // Product ABI facade: transport and filesystem owners remain separate
    // cores; only their thin N-API exports share the verified addon artifact.
    allowedInternalDependencies: ['agent-host-bridge', 'agent-session-bridge'],
  },
  'crates/agent-platform': {
    name: 'agent-platform',
    allowedInternalDependencies: [],
  },
  'crates/agent-protocol': {
    name: 'agent-protocol',
    allowedInternalDependencies: [],
  },
  'crates/agent-runner': {
    name: 'agent-runner',
    allowedInternalDependencies: [
      'agent-engine',
      'agent-platform',
      'agent-protocol',
      'agent-spool',
      'agent-tools',
    ],
  },
  'crates/agent-session-bridge': {
    name: 'agent-session-bridge',
    allowedInternalDependencies: ['agent-protocol', 'agent-session-store'],
  },
  'crates/agent-session-store': {
    name: 'agent-session-store',
    allowedInternalDependencies: [],
  },
  'crates/agent-spool': {
    name: 'agent-spool',
    allowedInternalDependencies: [],
  },
  'crates/agent-tools': {
    name: 'agent-tools',
    allowedInternalDependencies: [],
  },
  'crates/agentd-supervisor': {
    name: 'agentd-supervisor',
    allowedInternalDependencies: ['agent-platform', 'agent-protocol'],
  },
};

interface DependencyDeclaration {
  alias: string;
  packageName?: string;
  path?: string;
  section: string;
  line: number;
}

function runtimePath(path: string): string {
  return relative(RUNTIME_ROOT, path).split(sep).join('/');
}

function stripComment(line: string): string {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (quote === '"' && character === '\\') {
      escaped = true;
    } else if (quote && character === quote) {
      quote = '';
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    } else if (!quote && character === '#') {
      return line.slice(0, index).trim();
    }
  }
  return line.trim();
}

function unquote(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return undefined;
}

function parseKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : unquote(trimmed);
}

function assignment(line: string): { key: string; value: string } | undefined {
  const match = /^((?:"(?:\\.|[^"])*"|'[^']*'|[A-Za-z0-9_-]+))\s*=\s*(.+)$/.exec(line);
  if (!match) return undefined;
  const key = parseKey(match[1]);
  return key ? { key, value: match[2].trim() } : undefined;
}

function sectionName(line: string): string | undefined {
  const arrayTable = /^\[\[([^\]]+)]]$/.exec(line);
  if (arrayTable) return arrayTable[1].trim();
  const table = /^\[([^\]]+)]$/.exec(line);
  return table?.[1].trim();
}

function dependencySection(section: string): { nestedAlias?: string } | undefined {
  const match = /^(?:target\..+\.)?(?:dev-|build-)?dependencies(?:\.(.+))?$/.exec(section);
  if (!match) return undefined;
  const nestedAlias = match[1] ? parseKey(match[1]) : undefined;
  return match[1] && !nestedAlias ? undefined : { nestedAlias };
}

function inlineStringField(value: string, field: string): string | undefined {
  if (!value.startsWith('{') || !value.endsWith('}')) return undefined;
  const match = new RegExp(
    `(?:^|,)\\s*${field}\\s*=\\s*("(?:\\\\.|[^"])*"|'[^']*')\\s*(?=,|$)`,
  ).exec(value.slice(1, -1));
  return match ? unquote(match[1]) : undefined;
}

function parsePackageName(manifest: string, errors: string[]): string | undefined {
  let section = '';
  for (const [offset, rawLine] of readFileSync(manifest, 'utf8').split(/\r?\n/).entries()) {
    const line = stripComment(rawLine);
    const nextSection = sectionName(line);
    if (nextSection) {
      section = nextSection;
      continue;
    }
    const parsed = assignment(line);
    if (section === 'package' && parsed?.key === 'name') {
      const name = unquote(parsed.value);
      if (name) return name;
      errors.push(`${runtimePath(manifest)}:${offset + 1}: invalid package name`);
      return undefined;
    }
  }
  errors.push(`${runtimePath(manifest)}: missing [package].name`);
  return undefined;
}

function parseDependencies(manifest: string, errors: string[]): DependencyDeclaration[] {
  const declarations: DependencyDeclaration[] = [];
  let section = '';
  let nested: DependencyDeclaration | undefined;
  const lines = readFileSync(manifest, 'utf8').split(/\r?\n/);

  for (const [offset, rawLine] of lines.entries()) {
    const line = stripComment(rawLine);
    if (!line) continue;
    const nextSection = sectionName(line);
    if (nextSection) {
      if (nested) declarations.push(nested);
      nested = undefined;
      section = nextSection;
      const dependency = dependencySection(section);
      if (dependency?.nestedAlias) {
        nested = { alias: dependency.nestedAlias, section, line: offset + 1 };
      }
      continue;
    }

    const dependency = dependencySection(section);
    if (!dependency) continue;
    const parsed = assignment(line);
    if (!parsed) {
      errors.push(`${runtimePath(manifest)}:${offset + 1}: unsupported dependency syntax`);
      continue;
    }
    if (nested) {
      if (parsed.key === 'path') nested.path = unquote(parsed.value);
      if (parsed.key === 'package') nested.packageName = unquote(parsed.value);
      continue;
    }
    if (parsed.value.startsWith('{') && !parsed.value.endsWith('}')) {
      errors.push(`${runtimePath(manifest)}:${offset + 1}: multiline dependency is unsupported`);
      continue;
    }
    declarations.push({
      alias: parsed.key,
      packageName: inlineStringField(parsed.value, 'package'),
      path: inlineStringField(parsed.value, 'path'),
      section,
      line: offset + 1,
    });
  }
  if (nested) declarations.push(nested);
  return declarations;
}

function parseWorkspaceMembers(errors: string[]): string[] {
  const text = readFileSync(ROOT_MANIFEST, 'utf8');
  const match = /\[workspace]\s+members\s*=\s*\[([\s\S]*?)]/m.exec(text);
  if (!match) {
    errors.push('Cargo.toml: missing [workspace].members');
    return [];
  }
  const members = [...match[1].matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((item) => (item[1] ?? item[2]).replaceAll('\\', '/').replace(/\/$/, ''));
  const residue = match[1].replace(/"[^"]*"|'[^']*'|[\s,]/g, '');
  if (residue || members.length === 0) errors.push('Cargo.toml: invalid workspace member list');
  return members;
}

function collectCrateManifests(path: string, output: string[]): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'target' || entry.name.startsWith('.')) continue;
    const directory = join(path, entry.name);
    const manifest = join(directory, 'Cargo.toml');
    if (existsSync(manifest)) output.push(manifest);
    collectCrateManifests(directory, output);
  }
}

function collectProductionRustSources(path: string, output: string[]): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const candidate = join(path, entry.name);
    if (entry.isDirectory()) {
      collectProductionRustSources(candidate, output);
    } else if (entry.isFile() && entry.name.endsWith('.rs') && entry.name !== 'tests.rs') {
      output.push(candidate);
    }
  }
}

function validateCanonicalSupervisorSpawnEffect(errors: string[]): void {
  const sources: string[] = [];
  collectProductionRustSources(SUPERVISOR_SOURCE_ROOT, sources);
  const callsites = sources.flatMap((source) =>
    readFileSync(source, 'utf8')
      .split(/\r?\n/)
      .flatMap((line, offset) =>
        line.includes('.spawn_runner_contained_with_handles(')
          ? [{ path: runtimePath(source), line: offset + 1 }]
          : [],
      ),
  );
  if (
    callsites.length !== 1 ||
    callsites[0]?.path !== CANONICAL_SUPERVISOR_SPAWN_EFFECT
  ) {
    const found =
      callsites.map((callsite) => `${callsite.path}:${callsite.line}`).join(', ') || 'none';
    errors.push(
      `supervisor physical spawn must have one canonical direct callsite at ${CANONICAL_SUPERVISOR_SPAWN_EFFECT} (found: ${found})`,
    );
  }
}

function main(): void {
  const errors: string[] = [];
  if (!existsSync(ROOT_MANIFEST)) {
    console.error('Rust-agent crate boundary failed: native/agent-runtime/Cargo.toml is missing.');
    process.exit(1);
  }

  const members = parseWorkspaceMembers(errors);
  const memberSet = new Set(members);
  for (const member of members) {
    if (!CRATE_RULES[member]) errors.push(`unknown workspace crate: ${member}`);
  }
  for (const expected of Object.keys(CRATE_RULES)) {
    if (!memberSet.has(expected)) errors.push(`required workspace crate is missing: ${expected}`);
  }

  const discovered: string[] = [];
  collectCrateManifests(join(RUNTIME_ROOT, 'crates'), discovered);
  for (const manifest of discovered) {
    const member = runtimePath(dirname(manifest));
    if (!memberSet.has(member)) errors.push(`unlisted crate manifest: ${runtimePath(manifest)}`);
  }

  const nameToMember = new Map(
    Object.entries(CRATE_RULES).map(([member, rule]) => [rule.name, member]),
  );
  const edges = new Set<string>();
  for (const member of members) {
    const rule = CRATE_RULES[member];
    if (!rule) continue;
    const manifest = join(RUNTIME_ROOT, member, 'Cargo.toml');
    if (!existsSync(manifest)) {
      errors.push(`${member}: Cargo.toml is missing`);
      continue;
    }
    const packageName = parsePackageName(manifest, errors);
    if (packageName !== rule.name) {
      errors.push(`${member}: expected package ${rule.name}, found ${packageName ?? '<invalid>'}`);
    }

    for (const dependency of parseDependencies(manifest, errors)) {
      const declaredName = dependency.packageName ?? dependency.alias;
      const declaredMember = nameToMember.get(declaredName);
      if (!dependency.path && !declaredMember) continue;
      if (!dependency.path) {
        errors.push(
          `${rule.name}:${dependency.line}: internal dependency ${declaredName} must use an explicit path`,
        );
        continue;
      }

      const targetManifest = resolve(dirname(manifest), dependency.path, 'Cargo.toml');
      const targetMember = runtimePath(dirname(targetManifest));
      const targetRule = CRATE_RULES[targetMember];
      if (!targetRule || !existsSync(targetManifest)) {
        errors.push(
          `${rule.name}:${dependency.line}: unknown local dependency path ${dependency.path}`,
        );
        continue;
      }
      if (declaredName !== targetRule.name) {
        errors.push(
          `${rule.name}:${dependency.line}: dependency ${declaredName} resolves to ${targetRule.name}`,
        );
        continue;
      }
      if (!rule.allowedInternalDependencies.includes(targetRule.name)) {
        const allowed = rule.allowedInternalDependencies.join(', ') || 'none';
        errors.push(
          `${rule.name} -> ${targetRule.name} is forbidden (allowed: ${allowed})`,
        );
        continue;
      }
      edges.add(`${rule.name}->${targetRule.name}`);
    }
  }
  validateCanonicalSupervisorSpawnEffect(errors);

  if (errors.length > 0) {
    console.error(`Rust-agent crate boundary failed (${errors.length}):`);
    for (const error of [...new Set(errors)].sort()) console.error(`  ${error}`);
    process.exit(1);
  }
  console.log(
    `Rust-agent crate graph holds: ${members.length} crate(s), ${edges.size} internal edge(s).`,
  );
}

main();
