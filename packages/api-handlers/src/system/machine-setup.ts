import type { AsyncStream, MachineSetupEvent } from '@mcp/api-bus';
import { runMachineSetup, type MachineProgress } from '@mcp/services/podman-machine/index.js';
import { streamFromCallbacks } from '../projects/index.js';

/**
 * Stream the guided Podman-machine setup. Reuses the same callback→AsyncStream
 * bridge the scaffold wizard uses; translates the services `MachineProgress`
 * frames into the wire `MachineSetupEvent` shape.
 */
export function machineSetupStream(signal?: AbortSignal): AsyncStream<MachineSetupEvent> {
  return streamFromCallbacks<MachineSetupEvent>((emit) => {
    emit({ event: 'start', data: { platform: process.platform } });
    return runMachineSetup((p) => emit(toEvent(p)), { signal });
  });
}

function toEvent(p: MachineProgress): MachineSetupEvent {
  switch (p.kind) {
    case 'phase':
      return { event: 'phase', data: { phase: p.phase, label: p.label } };
    case 'log':
      return { event: 'log', data: { stream: p.stream, chunk: p.chunk } };
    case 'done':
      return { event: 'done', data: { ok: true } };
    case 'error':
      return { event: 'error', data: { message: p.message, stderrTail: p.stderrTail } };
  }
}
