
/** Entry in the tuple-hash dedup table (Kimi-style anti-loop). */
export interface DupCallEntry {
  count: number;
  firstTurn: number;
  lastUseId: string;
}
