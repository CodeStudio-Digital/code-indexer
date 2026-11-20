/**
 * Subagent collector — Frente C (PR 3 da reavaliação).
 *
 * Solves the "black box" problem: today a subagent returns ONLY its final
 * assistant text (`finalText`). If the sub did 30 tool_calls finding
 * critical info, the parent never sees any of it. The model summarizes
 * what it remembers, often imprecisely.
 *
 * The collector is a small object the parent creates BEFORE spawning the
 * sub, hands to it via `ToolContext.subagentCollector`, and reads back
 * after `subRunner.run()` resolves. Three channels:
 *
 *   - `memos`         — short structured notes the sub explicitly emits
 *                       via the new `record_memo` tool.
 *   - `snapshots`     — reserved channel, currently DORMANT: the snapshot
 *                       MCP tools were retired, so nothing mirrors here today.
 *                       Kept as generic infra for a future mirrored write.
 *   - `boardPosts`    — `post_to_board(kind='deliverable'|...)` writes
 *                       (when the sub is inside a company session and the
 *                       master pre-approved board access).
 *
 * The collector is intentionally pure data + small mutators — NO side
 * effects of its own. Persistence (DB, board) still happens via the
 * usual tool handlers; the collector only mirrors them so the parent
 * gets a structured copy in addition to whatever the underlying store
 * already did.
 *
 * Caps prevent runaway growth from a misbehaving sub: max 50 memos, max
 * 20 snapshots, max 20 board posts per run. Beyond the cap entries are
 * silently dropped (with a warn log) — the alternative would be throwing
 * mid-run which is worse UX than truncation.
 */

import { isUuid } from '@mcp/session-storage/types.js';

export type SubagentMemoKind = 'observation' | 'decision' | 'warning' | 'progress';

export interface SubagentMemo {
  text: string;
  kind: SubagentMemoKind;
  timestamp: string;
}

export interface SubagentSnapshotRef {
  /** Snapshot id returned by mcp__add_snapshot. */
  id: string;
  /** Snapshot category (decision/pattern/architecture/…). */
  category: string;
  /** First 200 chars of the snapshot body, for quick reference. */
  preview: string;
  timestamp: string;
}

export interface SubagentBoardPostRef {
  /** Board post id, when the underlying store returned one. */
  id?: string;
  /** Kind of board post (deliverable/message/risk/…). */
  kind: string;
  /** First 200 chars of the post body. */
  preview: string;
  timestamp: string;
}

const MAX_MEMOS = 50;
export const MAX_MEMO_CHARS = 300;
const MAX_SNAPSHOTS = 20;
const MAX_BOARD_POSTS = 20;

export class SubagentCollector {
  private readonly _memos: SubagentMemo[] = [];
  private readonly _snapshots: SubagentSnapshotRef[] = [];
  private readonly _boardPosts: SubagentBoardPostRef[] = [];

  recordMemo(text: string, kind: SubagentMemoKind = 'observation'): boolean {
    if (!text.trim() || text.length > MAX_MEMO_CHARS) return false;
    if (this._memos.length >= MAX_MEMOS) {
      console.warn(
        `[subagent-collector] memo cap (${MAX_MEMOS}) reached — dropping subsequent memos`,
      );
      return false;
    }
    this._memos.push({ text, kind, timestamp: new Date().toISOString() });
    return true;
  }

  recordSnapshot(id: string, category: string, body: string): boolean {
    if (this._snapshots.length >= MAX_SNAPSHOTS) return false;
    this._snapshots.push({
      id,
      category,
      preview: body.length > 200 ? body.slice(0, 197) + '...' : body,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  recordBoardPost(kind: string, body: string, id?: string): boolean {
    if (id !== undefined && !isUuid(id)) {
      throw new TypeError('board post id must be a canonical UUID');
    }
    if (this._boardPosts.length >= MAX_BOARD_POSTS) return false;
    this._boardPosts.push({
      id: id?.toLowerCase(),
      kind,
      preview: body.length > 200 ? body.slice(0, 197) + '...' : body,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  /** Read-only snapshot of everything collected so far. */
  snapshot(): { memos: SubagentMemo[]; snapshots: SubagentSnapshotRef[]; boardPosts: SubagentBoardPostRef[] } {
    return {
      memos: this._memos.map(entry => ({ ...entry })),
      snapshots: this._snapshots.map(entry => ({ ...entry })),
      boardPosts: this._boardPosts.map(entry => ({ ...entry })),
    };
  }

  /** True when at least one entry exists in any channel. */
  hasContent(): boolean {
    return this._memos.length + this._snapshots.length + this._boardPosts.length > 0;
  }
}
