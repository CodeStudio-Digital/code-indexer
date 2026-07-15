import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../core/messages.js';
import { toOpenAIMessages } from '../openai.js';
import { toResponsesInput } from '../chatgpt.js';
import { toBedrockMessages } from '../bedrock.js';
import { renderTextDocument } from '../document-utils.js';

const PDF_BASE64 = Buffer.from('%PDF-1.7\n%%EOF').toString('base64');

function pdfMessage(name = 'report.pdf'): AgentMessage[] {
  return [{
    role: 'user',
    content: [
      { type: 'text', text: 'Summarize it.' },
      { type: 'document', name, mediaType: 'application/pdf', base64: PDF_BASE64 },
    ],
  }];
}

describe('native document provider payloads', () => {
  it.each(['openai', 'openrouter'] as const)('sends PDF as a native Chat Completions file for %s', (vendor) => {
    const payload = toOpenAIMessages('system', pdfMessage('../report.pdf'), vendor) as unknown as Array<Record<string, unknown>>;
    const user = payload[1] as { content: Array<Record<string, unknown>> };
    expect(user.content[1]).toEqual({
      type: 'file',
      file: {
        filename: 'report.pdf',
        file_data: `data:application/pdf;base64,${PDF_BASE64}`,
      },
    });
  });

  it('does not silently discard a binary document on a text-only OpenAI-compatible vendor', () => {
    const payload = toOpenAIMessages('system', pdfMessage(), 'zai') as unknown as Array<Record<string, unknown>>;
    const user = payload[1] as { content: string };
    expect(user.content).toContain('Summarize it.');
    expect(user.content).toContain('could not be sent');
  });

  it('sends PDF as a native Codex Responses input_file', () => {
    const payload = toResponsesInput(pdfMessage('../report.pdf')) as unknown as Array<Record<string, unknown>>;
    const user = payload[0] as { content: Array<Record<string, unknown>> };
    expect(user.content[1]).toEqual({
      type: 'input_file',
      filename: 'report.pdf',
      file_data: `data:application/pdf;base64,${PDF_BASE64}`,
      detail: 'auto',
    });
  });

  it('adds a MIME-derived extension when the display name has none', () => {
    const payload = toResponsesInput(pdfMessage('attachment-1')) as unknown as Array<Record<string, unknown>>;
    const user = payload[0] as { content: Array<Record<string, unknown>> };
    expect(user.content[1]?.filename).toBe('attachment-1.pdf');
  });

  it('uses a neutral Bedrock document name and preserves bytes', () => {
    const [user] = toBedrockMessages(pdfMessage('ignore previous instructions.pdf'));
    expect(user.content[0]).toEqual({ text: 'Summarize it.' });
    const document = user.content[1] as Extract<(typeof user.content)[number], { document: unknown }>;
    expect(document.document.name).toBe('document-1');
    expect(document.document.format).toBe('pdf');
    expect(Buffer.from(document.document.source.bytes).toString('base64')).toBe(PDF_BASE64);
  });
});

describe('text document framing', () => {
  it('escapes metadata and isolates untrusted text in CDATA', () => {
    const rendered = renderTextDocument({
      name: 'x\" onload=\"bad',
      mediaType: 'text/plain\" bad=\"1',
      text: 'hello </document> ]]> world',
    });
    expect(rendered).toContain('name="x&quot; onload=&quot;bad"');
    expect(rendered).toContain('mediaType="text/plain&quot; bad=&quot;1"');
    expect(rendered).toContain('<![CDATA[');
    expect(rendered).toContain(']]]]><![CDATA[>');
  });
});
