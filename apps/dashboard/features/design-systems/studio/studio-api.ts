/**
 * Client do DS Studio — criação via POST multipart que responde um stream
 * SSE (`start/phase/log/done/error`, mesmo contrato do New Project
 * wizard). Parse manual do stream (EventSource não faz POST/multipart).
 */
import type { DesignSystemSession, DsStack } from '../design-system-api.js';

export type DsStudioMode = 'fidelity' | 'creative';

export interface DsStudioCreateInput {
  name: string;
  packageName: string;
  stack: DsStack;
  provider: string;
  model: string;
  /** 'fidelity' exige zip (validado no servidor); default 'creative'. */
  mode: DsStudioMode;
  zip?: File | null;
}

export interface DsStudioCreated {
  project: { id: number; name: string; root_path: string };
  ds_session: DesignSystemSession;
  coder_session_id: number;
}

export interface DsStudioProgressHandlers {
  onPhase?: (phase: string, label: string) => void;
  onLog?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

interface SseFrame {
  event: string;
  data: string;
}

/** Itera frames SSE de um body fetch (split em blocos \n\n). */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
    }
  }
}

export async function createDsStudio(
  input: DsStudioCreateInput,
  handlers: DsStudioProgressHandlers = {},
): Promise<DsStudioCreated> {
  const form = new FormData();
  form.set('name', input.name);
  form.set('package_name', input.packageName);
  form.set('stack', input.stack);
  form.set('provider', input.provider);
  form.set('model', input.model);
  form.set('mode', input.mode);
  if (input.zip) form.set('zip', input.zip);

  const r = await fetch('/api/design-system/studio', { method: 'POST', body: form });
  if (!r.ok || !r.body) {
    let msg = r.statusText;
    try {
      msg = ((await r.json()) as { error?: string }).error ?? msg;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${r.status}: ${msg}`);
  }

  for await (const frame of sseFrames(r.body)) {
    if (frame.event === 'phase') {
      const d = JSON.parse(frame.data) as { phase: string; label: string };
      handlers.onPhase?.(d.phase, d.label);
    } else if (frame.event === 'log') {
      const d = JSON.parse(frame.data) as { stream: 'stdout' | 'stderr'; chunk: string };
      handlers.onLog?.(d.stream, d.chunk);
    } else if (frame.event === 'error') {
      const d = JSON.parse(frame.data) as { message: string; stderrTail?: string };
      throw new Error(d.stderrTail ? `${d.message}\n${d.stderrTail}` : d.message);
    } else if (frame.event === 'done') {
      return JSON.parse(frame.data) as DsStudioCreated;
    }
  }
  throw new Error('Scaffold stream ended without a done event.');
}
