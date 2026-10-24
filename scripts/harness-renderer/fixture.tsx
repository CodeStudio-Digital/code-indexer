import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MessageList } from '../../apps/dashboard/features/chat/messages/MessageList.js';
import { buildTranscriptProjection } from '../../apps/dashboard/features/chat/transcript-projection.js';
import type { AssistantTurn, StreamBlock } from '../../apps/dashboard/hooks/useAgentStream.js';
import '../../apps/dashboard/index.css';

// Isolated component fixture. No application bootstrap, account, provider or
// session is loaded; the harness refuses all non-local browser requests.
await i18next.init({ lng: 'en', resources: {}, interpolation: { escapeValue: false } });
const initialBlocks: StreamBlock[] = Array.from({ length: 5_000 }, (_, index) => ({
  type: 'text', id: `fixture-${index}`, text: `Synthetic block ${index}.`,
}));
const noop = async () => {};
const handlers = { onAnswer: noop, onPlanResponse: noop, onTasksResponse: noop };

declare global {
  interface Window {
    runHarnessStream: (frames: number) => Promise<number[]>;
  }
}

function Fixture() {
  const [blocks, setBlocks] = useState(initialBlocks);
  const [probe, setProbe] = useState('');
  const turn = useMemo<AssistantTurn>(() => ({ blocks }), [blocks]);
  const projection = useMemo(() => buildTranscriptProjection(null, turn), [turn]);
  window.runHarnessStream = async (frames) => {
    const frameTimes: number[] = [];
    let previous = performance.now();
    for (let index = 0; index < frames; index++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => {
        const now = performance.now();
        frameTimes.push(now - previous);
        previous = now;
        setBlocks((current) => current.map((block, blockIndex) => blockIndex === current.length - 1
          ? { ...block, text: `Synthetic block 4999. Streaming ${index}.` } as StreamBlock
          : block));
        resolve();
      }));
    }
    return frameTimes;
  };
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <label>Responsiveness probe <input aria-label="Responsiveness probe" value={probe}
      onChange={(event) => setProbe(event.target.value)} /></label>
    <output data-probe>{probe}</output>
    <section style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <MessageList sessionData={null} currentTurn={turn} streaming doneReason={null}
        error={null} projection={projection} tasksState={null} handlers={handlers} />
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={i18next}><Fixture /></I18nextProvider>,
);
