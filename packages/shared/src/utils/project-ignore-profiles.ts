
export type ProjectIgnoreKind = 'java' | 'dotnet' | 'unity';

interface IgnoreProfile {
  /** Conventional spelling is retained so glob pruning works on Linux. */
  directories: readonly string[];
  exactFiles: readonly string[];
  fileSuffixes: readonly string[];
  filePatterns: readonly string[];
}

const JAVA_PROFILE: IgnoreProfile = {
  directories: [
    'target', 'build', 'out', 'bin', '.gradle', '.kotlin', '.settings',
    '.metadata', '.recommenders', '.cxx', '.externalNativeBuild', 'captures',
  ],
  exactFiles: ['.classpath', '.project', '.factorypath', 'dependency-reduced-pom.xml'],
  fileSuffixes: ['.iml'],
  filePatterns: ['hs_err_pid*.log', 'replay_pid*.log'],
};

const DOTNET_PROFILE: IgnoreProfile = {
  directories: [
    'bin', 'obj', '.vs', '.nuget', 'TestResults', 'artifacts',
    'BenchmarkDotNet.Artifacts', '_ReSharper.Caches', '.sonarqube', '.fake', 'ipch',
  ],
  exactFiles: [],
  fileSuffixes: [
    '.user', '.suo', '.userosscache', '.sln.docstates', '.nupkg', '.snupkg',
    '.coverage', '.coveragexml',
  ],
  filePatterns: [],
};

const UNITY_PROFILE: IgnoreProfile = {
  directories: [
    // Unity's generated/cache roots. Assets, Packages and ProjectSettings are
    // intentionally absent: they are authoritative project input.
    'Library', 'Temp', 'Logs', 'UserSettings', 'MemoryCaptures', 'Recordings',
    'bin', 'obj', 'Build', 'Builds', 'ExportedObj', '.vs', '.nuget', '.gradle',
    'TestResults', 'artifacts', 'BenchmarkDotNet.Artifacts',
  ],
  exactFiles: [],
  fileSuffixes: [
    // Unity regenerates these IDE artifacts. `.meta` remains on disk/in Git;
    // this only keeps it out of the code tree/index/watch stream.
    '.meta', '.csproj', '.sln', '.slnx', '.unityproj', '.pidb', '.booproj',
    '.svd', '.pdb', '.mdb', '.opendb', '.vc.db', '.user', '.userprefs', '.suo',
  ],
  // Unity's directory monitor drops (and immediately deletes) a
  // `~UnityDirMonSyncFile~<guid>` marker into every folder it watches — pure
  // churn that would otherwise spam the watcher/index with add+unlink pairs.
  filePatterns: ['~UnityDirMonSyncFile~*'],
};

export const PROFILES: Record<ProjectIgnoreKind, IgnoreProfile> = {
  java: JAVA_PROFILE,
  dotnet: DOTNET_PROFILE,
  unity: UNITY_PROFILE,
};

interface CompiledIgnoreProfile {
  directories: ReadonlySet<string>;
  exactFiles: ReadonlySet<string>;
  fileSuffixes: readonly string[];
  filePatterns: readonly string[];
}

function compileProfile(profile: IgnoreProfile): CompiledIgnoreProfile {
  return {
    directories: new Set(profile.directories.map((name) => name.toLowerCase())),
    exactFiles: new Set(profile.exactFiles.map((name) => name.toLowerCase())),
    fileSuffixes: profile.fileSuffixes.map((suffix) => suffix.toLowerCase()),
    filePatterns: profile.filePatterns.map((pattern) => pattern.toLowerCase()),
  };
}

export const COMPILED_PROFILES: Record<ProjectIgnoreKind, CompiledIgnoreProfile> = {
  java: compileProfile(JAVA_PROFILE),
  dotnet: compileProfile(DOTNET_PROFILE),
  unity: compileProfile(UNITY_PROFILE),
};
