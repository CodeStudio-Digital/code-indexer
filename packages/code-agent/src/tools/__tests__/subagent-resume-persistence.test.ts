import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { coderOrchestrationCheckpoints259 } from '@mcp/store/migrations/259_coder_orchestration_checkpoints.js';
import * as checkpoints from '../../sessions/store/orchestration-checkpoints.js';
import {
  clearSession,
  getGroup,
  retainGroup,
  type ResumableGroup,
  type ResumeCheckpointStore,
} from '../subagent-resume-registry.js';

const SESSION_ID = 91;
let db: Database.Database;
let store: ResumeCheckpointStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY);
    INSERT INTO coder_sessions (id) VALUES (${SESSION_ID});
  `);
  coderOrchestrationCheckpoints259.up(db);
  store = {
    saveOrchestrationCheckpoint: (input) => checkpoints.save(db, input),
    loadOrchestrationCheckpoint: (sessionId, kind, scopeId) =>
      checkpoints.load(db, sessionId, kind, scopeId),
    listOrchestrationCheckpoints: (sessionId, kind, limit) =>
      checkpoints.list(db, sessionId, kind, limit),
    removeOrchestrationCheckpoint: (sessionId, kind, scopeId, token) =>
      checkpoints.remove(db, sessionId, kind, scopeId, token),
    tryAcquireOrchestrationCheckpoint: (sessionId, kind, scopeId, leaseMs) =>
      checkpoints.tryAcquire(db, sessionId, kind, scopeId, leaseMs),
    releaseOrchestrationCheckpoint: (sessionId, kind, scopeId, token) =>
      checkpoints.release(db, sessionId, kind, scopeId, token),
    renewOrchestrationCheckpoint: (sessionId, kind, scopeId, token, leaseMs) =>
      checkpoints.renew(db, sessionId, kind, scopeId, token, leaseMs),
  };
});

afterEach(() => {
  clearSession(SESSION_ID);
  db.close();
});

describe('subagent resume checkpoint', () => {
  it('restores a redacted failed transcript after memory/executor recreation', () => {
    const now = Date.now();
    const group: ResumableGroup = {
      spawnId: 'spawn-restart',
      sessionId: SESSION_ID,
      provider: 'fake',
      model: 'fake-model',
      createdAt: now,
      lastTouchedAt: now,
      agents: [{
        agentIndex: 0,
        label: 'recover',
        task: 'Continue with api_key=TOP_SECRET_VALUE '
          + 'AKIA1234567890ABCDEF xoxb-1234567890-ABCDEFGHIJ '
          + 'DATABASE_PASSWORD=database-super-secret '
          + 'Qm9ndXNPcGFxdWVTZWNyZXQxMjM0NTY3ODkw',
        profileId: 'explore',
        maxTurns: 10,
        limits: { maxToolCalls: 20 },
        transcript: [
          { role: 'user', content: [{ type: 'text', text: 'Bearer TOP_SECRET_VALUE' }] },
          { role: 'assistant', content: [{ type: 'thinking', text: 'private reasoning' }] },
        ],
        reason: 'error',
        failureNote: 'password=TOP_SECRET_VALUE',
        toolCallCount: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        attempt: 1,
        capturedAt: now,
        approxBytes: 0,
      }],
    };

    retainGroup(SESSION_ID, group, store);
    const payload = db.prepare(`
      SELECT payload_json FROM coder_orchestration_checkpoints
      WHERE session_id=? AND checkpoint_kind='subagent_resume'
    `).get(SESSION_ID) as { payload_json: string };
    expect(payload.payload_json).not.toContain('TOP_SECRET_VALUE');
    expect(payload.payload_json).not.toContain('private reasoning');
    expect(payload.payload_json).not.toContain('AKIA1234567890ABCDEF');
    expect(payload.payload_json).not.toContain('xoxb-1234567890-ABCDEFGHIJ');
    expect(payload.payload_json).not.toContain('database-super-secret');
    expect(payload.payload_json).not.toContain('Qm9ndXNPcGFxdWVTZWNyZXQxMjM0NTY3ODkw');

    clearSession(SESSION_ID);
    const restored = getGroup(SESSION_ID, 'spawn-restart', store);
    expect(restored?.agents[0].reason).toBe('error');
    expect(restored?.agents[0].transcript?.length).toBeGreaterThan(0);
    expect(JSON.stringify(restored)).not.toContain('TOP_SECRET_VALUE');
  });
});
