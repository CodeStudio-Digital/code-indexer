/**
 * GPU detection for the training UI. Runs `nvidia-smi` (host, then WSL fallback)
 * to read total VRAM + GPU name, and maps that to a recommended base model.
 * Pure over an injected IShellPort so it works from a route handler or worker.
 */
import type { IShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { recommendedModel, modelsForVram, type BaseModel } from './base-models.js';

export interface GpuInfo {
  available: boolean;
  vramMb: number;
  gpuName: string;
  recommended: BaseModel | null;
  fits: BaseModel[];
  /** Where the GPU was found: 'host' | 'wsl' | 'none'. */
  via: 'host' | 'wsl' | 'none';
}

const SMI_ARGS = ['--query-gpu=memory.total,name', '--format=csv,noheader,nounits'];

function parseSmi(stdout: string): { vramMb: number; gpuName: string } | null {
  const line = stdout.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  const [mem, ...rest] = line.split(',');
  const vramMb = Math.round(Number(mem.trim()));
  if (!Number.isFinite(vramMb) || vramMb <= 0) return null;
  return { vramMb, gpuName: rest.join(',').trim() || 'NVIDIA GPU' };
}

async function trySmi(
  shell: IShellPort,
  program: string,
  args: string[],
): Promise<{ vramMb: number; gpuName: string } | null> {
  try {
    const r = await shell.spawn(program, args, { cwd: process.cwd(), timeoutMs: 8_000 });
    if ((r.exitCode ?? 1) !== 0) return null;
    return parseSmi(r.stdout);
  } catch {
    return null;
  }
}

export async function detectGpu(shell: IShellPort): Promise<GpuInfo> {
  const none: GpuInfo = {
    available: false, vramMb: 0, gpuName: '', recommended: null, fits: [], via: 'none',
  };

  // Host first, then WSL (the recommended training environment on Windows).
  let via: 'host' | 'wsl' = 'host';
  let info = await trySmi(shell, 'nvidia-smi', SMI_ARGS);
  if (!info) {
    info = await trySmi(shell, 'wsl.exe', ['nvidia-smi', ...SMI_ARGS]);
    via = 'wsl';
  }
  if (!info) return none;

  return {
    available: true,
    vramMb: info.vramMb,
    gpuName: info.gpuName,
    recommended: recommendedModel(info.vramMb),
    fits: modelsForVram(info.vramMb),
    via,
  };
}
