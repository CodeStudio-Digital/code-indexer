import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';

export type CsharpWorkspaceMode = 'project' | 'generated-unity' | 'generated-basic' | 'loose';

export interface CsharpWorkspace {
  cwd: string;
  rootPath: string;
  launchTarget: string;
  mode: CsharpWorkspaceMode;
  reason?: string;
}

const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', 'Library', 'Temp', 'Logs', 'obj', 'bin']);

function walkFiles(root: string, predicate: (path: string) => boolean, limit = 12_000): string[] {
  const found: string[] = [];
  const queue = [root];
  let visited = 0;
  while (queue.length > 0 && visited < limit) {
    const dir = queue.shift()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > limit) break;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(absolute);
      } else if (entry.isFile() && predicate(absolute)) {
        found.push(absolute);
      }
    }
  }
  return found;
}

function realProject(root: string): string | null {
  const candidates = walkFiles(root, (file) => ['.sln', '.slnx', '.csproj'].includes(extname(file).toLowerCase()));
  const rank = (file: string): number => ({ '.sln': 0, '.slnx': 1, '.csproj': 2 }[extname(file).toLowerCase()] ?? 3);
  candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return candidates[0] ?? null;
}

function read(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function packageIdentity(root: string): { name?: string; assemblyNames: string[] } {
  let name: string | undefined;
  try {
    const manifest = JSON.parse(read(join(root, 'package.json'))) as { name?: unknown };
    if (typeof manifest.name === 'string') name = manifest.name;
  } catch { /* not a package manifest */ }
  const assemblyNames = walkFiles(root, (file) => file.toLowerCase().endsWith('.asmdef'), 4_000)
    .map((file) => {
      try {
        const value = JSON.parse(read(file)) as { name?: unknown };
        return typeof value.name === 'string' ? value.name : '';
      } catch { return ''; }
    })
    .filter(Boolean);
  return { name, assemblyNames };
}

function unityHost(sourceRoot: string, packageName: string | undefined, roots: string[]): string | null {
  if (!packageName) return null;
  const normalizedSource = resolve(sourceRoot).replace(/\\/g, '/').toLowerCase();
  for (const root of roots) {
    if (resolve(root).toLowerCase() === resolve(sourceRoot).toLowerCase()) continue;
    const manifest = read(join(root, 'Packages', 'manifest.json'));
    if (!manifest) continue;
    const normalizedManifest = manifest.replace(/\\/g, '/').toLowerCase();
    if (manifest.includes(`\"${packageName}\"`) || normalizedManifest.includes(normalizedSource)) return root;
  }
  return null;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function absolutizeHintPaths(referenceXml: string, hostProject: string): string {
  return referenceXml.replace(/<HintPath>([^<]+)<\/HintPath>/gi, (_match, value: string) => {
    const path = /^[a-zA-Z]:[\\/]|^\//.test(value) ? value : resolve(dirname(hostProject), value);
    return `<HintPath>${xmlEscape(path)}</HintPath>`;
  });
}

function unityContext(hostRoot: string, assemblyNames: string[]): {
  references: string;
  defines?: string;
  langVersion?: string;
  targetFramework?: string;
  editorVersion?: string;
} {
  const projects = walkFiles(hostRoot, (file) => file.toLowerCase().endsWith('.csproj'), 4_000);
  const preferred = projects.find((file) => assemblyNames.includes(basename(file, '.csproj')))
    ?? projects.find((file) => basename(file, '.csproj') === 'Assembly-CSharp')
    ?? projects[0];
  if (!preferred) return { references: '' };
  const xml = read(preferred);
  const references = [
    ...(xml.match(/<Reference\b[^>]*\/>/gi) ?? []),
    ...(xml.match(/<Reference\b[^>]*>[\s\S]*?<\/Reference>/gi) ?? []),
  ].map((block) => absolutizeHintPaths(block, preferred)).join('\n    ');
  const value = (tag: string): string | undefined => new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i').exec(xml)?.[1]?.trim();
  const versionFile = read(join(hostRoot, 'ProjectSettings', 'ProjectVersion.txt'));
  return {
    references,
    defines: value('DefineConstants'),
    langVersion: value('LangVersion'),
    targetFramework: value('TargetFramework'),
    editorVersion: /^m_EditorVersion:\s*(.+)$/m.exec(versionFile)?.[1]?.trim(),
  };
}

function writeIfChanged(file: string, content: string): void {
  if (read(file) === content) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

export function resolveCsharpWorkspace(input: {
  sourceRoot: string;
  baseDir: string;
  projectId: number;
  serverVersion: string;
  registeredProjectRoots?: string[];
  dotnetRoot?: string;
}): CsharpWorkspace {
  const project = realProject(input.sourceRoot);
  if (project) {
    return { cwd: dirname(project), rootPath: dirname(project), launchTarget: project, mode: 'project' };
  }

  const identity = packageIdentity(input.sourceRoot);
  const looksLikeUnityPackage = identity.assemblyNames.length > 0;
  const host = looksLikeUnityPackage
    ? unityHost(input.sourceRoot, identity.name, input.registeredProjectRoots ?? [])
    : null;
  const context: ReturnType<typeof unityContext> = host
    ? unityContext(host, identity.assemblyNames)
    : { references: '' };
  const workspace = join(input.baseDir, '.workspaces', `omnisharp@${input.serverVersion}`, String(input.projectId), 'generated');
  const generatedProject = join(workspace, 'CodeStudio.Generated.csproj');
  const sourceGlob = join(resolve(input.sourceRoot), '**', '*.cs');
  const mode: CsharpWorkspaceMode = host ? 'generated-unity' : 'generated-basic';
  const reason = host
    ? (context.references ? undefined : `Unity host ${host} was found, but its generated references are unavailable.`)
    : looksLikeUnityPackage
      ? 'No registered Unity host consumes this package; Unity APIs are in limited mode.'
      : 'No .sln/.slnx/.csproj was found; using a temporary netstandard2.1 workspace.';
  const defines = context.defines
    ? `<DefineConstants>${xmlEscape(context.defines)}</DefineConstants>`
    : '';
  const editorVersion = context.editorVersion
    ? `<UnityEditorVersion>${xmlEscape(context.editorVersion)}</UnityEditorVersion>`
    : '';
  const netstandardReferences = (() => {
    if (!input.dotnetRoot) return '';
    const packRoot = join(input.dotnetRoot, 'packs', 'NETStandard.Library.Ref');
    let versions: string[] = [];
    try { versions = readdirSync(packRoot).sort().reverse(); } catch { return ''; }
    for (const version of versions) {
      const refs = join(packRoot, version, 'ref', 'netstandard2.1');
      let dlls: string[] = [];
      try { dlls = readdirSync(refs).filter((file) => file.toLowerCase().endsWith('.dll')); } catch { continue; }
      if (dlls.length > 0) {
        return dlls.map((file) => `<Reference Include="${xmlEscape(basename(file, '.dll'))}"><HintPath>${xmlEscape(join(refs, file))}</HintPath></Reference>`).join('\n    ');
      }
    }
    return '';
  })();
  // Classic MSBuild shape is intentional. Managed runtimes may contain the
  // Roslyn runtime + reference packs but not Microsoft.NET.Sdk; an SDK-style
  // generated project would then hang OmniSharp's initialize while its SDK
  // resolver searches. Direct netstandard2.1 references stay self-contained.
  const xml = `<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkIdentifier>.NETStandard</TargetFrameworkIdentifier>
    <TargetFrameworkVersion>v2.1</TargetFrameworkVersion>
    <_TargetFrameworkVersionWithoutV>2.1</_TargetFrameworkVersionWithoutV>
    <OutputType>Library</OutputType>
    <AssemblyName>CodeStudio.Generated</AssemblyName>
    <RootNamespace>CodeStudio.Generated</RootNamespace>
    <LangVersion>${xmlEscape(context.langVersion ?? 'latest')}</LangVersion>
    ${defines}
    ${editorVersion}
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${xmlEscape(sourceGlob)}" />
  </ItemGroup>
  ${(netstandardReferences || context.references) ? `<ItemGroup>\n    ${netstandardReferences}\n    ${context.references}\n  </ItemGroup>` : ''}
  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />
</Project>
`;
  writeIfChanged(generatedProject, xml);
  // Process discovery happens from `cwd` (generated project); LSP rootUri stays
  // on the real source tree so opened file URIs belong to the workspace.
  return { cwd: workspace, rootPath: resolve(input.sourceRoot), launchTarget: generatedProject, mode, reason };
}
