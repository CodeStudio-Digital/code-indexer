/**
 * Escaping regressions for body content in generated snippets:
 *  - Python: a bare CR inside a "..." literal is a SyntaxError (must be \r-escaped).
 *  - PowerShell: a line beginning with '@ closes a here-string early (must fall
 *    back to a base64-decoded body so arbitrary content can't terminate it / inject).
 */
import { describe, it, expect } from 'vitest';
import { generate } from '../index.js';
import type { CodegenRequest } from '../types.js';

const rawReq = (content: string): CodegenRequest => ({
  method: 'POST', url: 'https://api.example.com/x', headers: [],
  body: { kind: 'raw', content, contentType: 'text/plain' },
});

describe('codegen body escaping', () => {
  it('python escapes CR (CRLF body) instead of producing an unterminated literal', () => {
    const code = generate('python', rawReq('line1\r\nline2'));
    expect(code).toContain('\\r\\n');
    expect(code).not.toMatch(/data = "line1\r/); // no raw CR in the literal
  });

  it("powershell base64-encodes a body containing a here-string terminator ('@)", () => {
    const code = generate('powershell', rawReq("safe\n'@\nWrite-Host pwned"));
    expect(code).toContain('FromBase64String');
    expect(code).not.toContain("'@\nWrite-Host pwned"); // the injection can't terminate the here-string
  });

  it('powershell still uses a here-string for ordinary bodies', () => {
    const code = generate('powershell', rawReq('{"a":1}'));
    expect(code).toContain("@'");
    expect(code).not.toContain('FromBase64String');
  });
});
