export interface AutoContinueSignal {
  consume(): boolean;
}

export function consumeAutoContinueSignals(
  humanInLoop: AutoContinueSignal,
  master: AutoContinueSignal,
): boolean {
  // Both producers mirror the same acknowledgement for compatibility. Consume
  // both eagerly: `human() || master()` short-circuits and leaves the second
  // flag armed, resurrecting an already-completed Master once per flag.
  const humanSignal = humanInLoop.consume();
  const lifecycleSignal = master.consume();
  return humanSignal || lifecycleSignal;
}
