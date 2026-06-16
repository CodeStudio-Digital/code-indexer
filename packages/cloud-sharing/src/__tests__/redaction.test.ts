/**
 * Redaction golden vectors — the security core. Plants known secrets/paths/PII
 * and asserts ZERO survive. Covers the standard vs strict split, the snapshot
 * projection (text + tool_use summaries scrubbed; image/document/tool_result
 * carry no free text), and the high-entropy strict catch.
 */
import { describe, it, expect } from 'vitest';
import { redactText, redactSnapshot, type ShareSnapshot } from '@cloudstudio/cloud-sharing';

const SECRETS = [
  'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',
  'sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB',
  'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AKIAIOSFODNN7EXAMPLE',
  'AIzaSyA1234567890abcdefghijklmnopqrstuv',
  'xoxb-1234567890-ABCDEFGHIJ',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123456',
  'postgres://user:p4ssw0rd@db.internal:5432/app',
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBjunk\n-----END RSA PRIVATE KEY-----',
];

describe('redactText — secrets (standard level)', () => {
  for (const secret of SECRETS) {
    it(`scrubs: ${secret.slice(0, 24)}…`, () => {
      const r = redactText(`before ${secret} after`, 'standard');
      expect(r.redactionCount).toBeGreaterThanOrEqual(1);
      expect(r.value).not.toContain(secret);
      expect(r.value).toContain('before');
      expect(r.value).toContain('after');
    });
  }

  it('redacts a KEY=value secret line, keeping the key name', () => {
    const r = redactText('API_SECRET=supersecretvalue123', 'standard');
    expect(r.value).toContain('API_SECRET=‹redacted›');
    expect(r.value).not.toContain('supersecretvalue123');
  });
});

describe('redactText — paths', () => {
  it('masks absolute home paths but keeps relative example paths', () => {
    const r = redactText('see C:\\Users\\maico\\app\\secret.ts and /home/maicon/.env vs src/foo/bar.ts', 'standard');
    expect(r.value).not.toContain('maico');
    expect(r.value).not.toContain('maicon');
    expect(r.value).toContain('‹path›');
    expect(r.value).toContain('src/foo/bar.ts'); // relative paths preserved for readability
  });
  it('masks ~/ home and /root paths', () => {
    const r = redactText('~/private/keys and /root/.ssh/id_rsa', 'standard');
    expect(r.value).not.toContain('private/keys');
    expect(r.value).not.toContain('.ssh/id_rsa');
  });
});

describe('redactText — strict adds email + high-entropy', () => {
  it('keeps emails at standard, redacts at strict', () => {
    expect(redactText('reach me at user@example.com', 'standard').value).toContain('user@example.com');
    expect(redactText('reach me at user@example.com', 'strict').value).not.toContain('user@example.com');
  });
  it('redacts a long opaque high-entropy token at strict', () => {
    const tok = 'Zx9Q2pLkM7vR4tB1nW8sY3cF6hJ0aD5eG';
    const r = redactText(`token ${tok} end`, 'strict');
    expect(r.value).not.toContain(tok);
  });
  it('does NOT redact ordinary prose words at strict', () => {
    const prose = 'the quick brown fox jumps over the lazy dog repeatedly today';
    expect(redactText(prose, 'strict').value).toBe(prose);
  });
});

describe('redactSnapshot — whole-snapshot projection', () => {
  const snap: ShareSnapshot = {
    schemaVersion: 1,
    title: 'debugging with key sk-proj-CCCCCCCCCCCCCCCCCCCCCCCC',
    model: 'anthropic/claude-opus',
    createdAtMs: 1_700_000_000_000,
    messages: [
      { idx: 0, role: 'user', blocks: [{ type: 'text', text: 'my path is /home/bob/app' }] },
      {
        idx: 1,
        role: 'assistant',
        blocks: [
          { type: 'tool_use', name: 'read_file', inputSummary: 'read C:\\Users\\bob\\.env' },
          { type: 'tool_result', toolName: 'read_file', status: 'ok', redacted: true },
          { type: 'image', redacted: true },
        ],
      },
    ],
  };

  it('scrubs title, text blocks, and tool_use summaries; counts redactions', () => {
    const { value, redactionCount } = redactSnapshot(snap, 'standard');
    expect(redactionCount).toBeGreaterThanOrEqual(3); // title key + home path + win path
    expect(value.title).not.toContain('sk-proj');
    expect((value.messages[0].blocks[0] as { text: string }).text).not.toContain('/home/bob');
    const toolUse = value.messages[1].blocks[0] as { inputSummary: string };
    expect(toolUse.inputSummary).not.toContain('bob');
    // type-redacted blocks pass through untouched
    expect(value.messages[1].blocks[1]).toEqual({ type: 'tool_result', toolName: 'read_file', status: 'ok', redacted: true });
    expect(value.messages[1].blocks[2]).toEqual({ type: 'image', redacted: true });
  });
});
