/**
 * THROWAWAY — Onda 0 spike. Delete once the gate is answered.
 *
 * `utilityProcess` entry. Answers assertion (d) — whether a MessagePortMain
 * minted in main survives transfer into a utility process and carries traffic
 * — then runs the capability probe and reports back over `parentPort`.
 *
 * Note the asymmetry this also documents: `ParentPort.postMessage` takes no
 * `transfer` argument, so a utility can never hand a port BACK to main. Main is
 * the sole minter of every MessageChannelMain, which is why the real migration
 * needs one multiplexed renderer port instead of a port per stream.
 */

import { runProbe } from './probe.js';

const port = process.parentPort;
if (!port) throw new Error('[spike] not running inside utilityProcess');

port.on('message', (event) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type !== 'start') return;

  const transferred = event.ports?.[0];
  if (transferred) {
    // Prove the transferred port is live in BOTH directions before reporting.
    transferred.on('message', (inner) => {
      const payload = inner.data as { type?: string } | undefined;
      if (payload?.type === 'ping') transferred.postMessage({ type: 'pong', from: 'utility' });
    });
    transferred.start();
    transferred.postMessage({ type: 'hello', from: 'utility' });
  }

  void runProbe().then((report) => {
    port.postMessage({
      type: 'report',
      report: {
        ...report,
        checks: [
          ...report.checks,
          {
            name: 'messageport-transfer',
            ok: !!transferred,
            detail: transferred
              ? 'MessagePortMain received in utility and started'
              : 'no port arrived in the transfer list',
          },
        ],
      },
    });
  }).catch((err: unknown) => {
    port.postMessage({ type: 'fatal', message: (err as Error)?.message ?? String(err) });
  });
});
