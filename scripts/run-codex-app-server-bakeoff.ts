import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  DirectOssEngineProcessSupervisor,
  SupervisedCodexAppServerRun,
  type OssEngineEvent,
  type OssEngineToolHostPort,
} from '../packages/agent-runtime-host/src/index.js';
import type {
  AgentRunAttemptId,
  AgentRunId,
  SessionCommandId,
  SessionId,
} from '../packages/agent-runtime-contracts/src/index.js';

const options = parseArgs(process.argv.slice(2));
const events: OssEngineEvent[] = [];
const toolHost: OssEngineToolHostPort = {
  invoke: async (call) => ({
    callId: call.callId,
    accepted: true,
    started: true,
    outcome: 'completed',
    contentItems: [{
      type: 'inputText',
      text: 'Synthetic index result: AgentRunAttempt is the isolated execution unit.',
    }],
  }),
};
const now = Date.now();
const sessionId = randomUUID() as SessionId;
const commandId = randomUUID() as SessionCommandId;
const agentRunId = randomUUID() as AgentRunId;
const attemptId = randomUUID() as AgentRunAttemptId;
const runner = new SupervisedCodexAppServerRun({
  supervisor: new DirectOssEngineProcessSupervisor(),
  toolHost,
  executable: options.binary,
  environment: bakeoffEnvironment(),
  resourceBudget: {
    maxMemoryBytes: 1024n * 1024n * 1024n,
    maxCpuTimeMs: 60_000n,
    maxWallTimeMs: BigInt(options.timeoutMs),
    maxProcesses: 8,
    maxOpenHandles: 4096,
  },
  requiredEnforcedLimits: ['memory', 'cpu_time', 'wall_time', 'processes'],
  clientVersion: '0.1.0',
  expectedToolCalls: 1,
  interruptGraceMs: 2_000,
  peer: {
    maxInboundBytes: 1024 * 1024,
    maxPendingRequests: 16,
    maxConcurrentServerRequests: 2,
  },
});

const supervised = await runner.run({
  candidate: 'codex_app_server',
  candidateVersion: options.version,
  protocolVersion: 'app-server-v2-experimental-tools',
  protocolSchemaDigest: options.schemaDigest,
  authority: {
    sessionId,
    commandId,
    agentRunId,
    attemptId,
    executorOwnerId: `bakeoff:${process.pid}`,
    fencingEpoch: 1n,
    correlationId: randomUUID(),
    rootAgentRunId: agentRunId,
    leaseExpiresAtUnixMs: BigInt(now + options.timeoutMs + 5_000),
    deadlineAtUnixMs: BigInt(now + options.timeoutMs),
  },
  cwd: options.cwd,
  prompt: [
    'Use the CodeStudio indexed-code search capability exactly once.',
    'Search for AgentRunAttempt. Do not use shell, filesystem, web, MCP, or any other tool.',
    'After the tool result, answer with one short sentence.',
  ].join(' '),
  capabilities: [{
    capabilityId: 'index.search@bakeoff-v1',
    canonicalName: 'search_indexed_code',
    description: 'Search the CodeStudio index for code symbols and concepts.',
    descriptorDigest: 'a'.repeat(64),
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    mutates: false,
  }],
}, (event) => {
  events.push(event);
}, AbortSignal.timeout(options.timeoutMs));

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  result: supervised.result,
  certification: supervised.certification,
  evidence: {
    launchReceipt: supervised.launchReceipt,
    finalization: supervised.finalization,
    eventKinds: events.map((event) => event.kind),
  },
}, null, 2)}\n`);

function bakeoffEnvironment(): Readonly<Record<string, string>> {
  const allowlist = [
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'CODEX_HOME',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ] as const;
  const environment: Record<string, string> = {};
  for (const name of allowlist) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  if (!environment.SYSTEMROOT) {
    throw new Error('SYSTEMROOT is required for the Windows bake-off environment');
  }
  return Object.freeze(environment);
}

function parseArgs(args: string[]): {
  binary: string;
  cwd: string;
  version: string;
  schemaDigest: string;
  timeoutMs: number;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument ${key ?? ''}`);
    values.set(key.slice(2), value);
  }
  const binary = values.get('binary');
  const cwd = values.get('cwd') ?? process.cwd();
  const version = values.get('version');
  const schemaDigest = values.get('schema-digest');
  const timeoutMs = Number(values.get('timeout-ms') ?? '60000');
  if (!binary || !isAbsolute(binary)) throw new Error('--binary must be an absolute path');
  if (!isAbsolute(cwd)) throw new Error('--cwd must be an absolute path');
  if (!version) throw new Error('--version is required');
  if (!schemaDigest || !/^[a-f0-9]{64}$/.test(schemaDigest)) {
    throw new Error('--schema-digest must be a lowercase SHA-256 value');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error('--timeout-ms must be between 1000 and 300000');
  }
  return { binary, cwd, version, schemaDigest, timeoutMs };
}
