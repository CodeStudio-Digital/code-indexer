import { createInterface } from 'node:readline';
import { TsLanguageService } from '@mcp/code-agent/lsp/ts-service.js';
import { lspPage, type AgentLspQuery, type AgentLspAnswer } from '@mcp/code-agent/ports/lsp-port.js';

// Stdout is the framed protocol; compiler diagnostics belong on stderr.
console.log = console.info = console.warn = (...args: unknown[]) => console.error(...args);
let current: { root: string; service: TsLanguageService } | undefined;
// No editor buffers are mirrored: agent queries observe committed files.
async function execute({ id, input }: { id: number; input: AgentLspQuery }) {
  try {
    if (current?.root !== input.root) {
      current?.service.dispose();
      current = { root: input.root, service: new TsLanguageService(input.root, true) };
    } else current.service.refreshDiskProject();
    const service = current.service; let answer: AgentLspAnswer;
    switch (input.op) {
      case 'definition': answer = { kind: 'locations', ...lspPage(service.getDefinition(input.file, input.line!, input.column!).targets, input) }; break;
      case 'references': answer = { kind: 'locations', ...lspPage(service.getReferences(input.file, input.line!, input.column!).references, input) }; break;
      case 'diagnostics': answer = { kind: 'diagnostics', ...lspPage(service.getDiagnostics(input.file), input) }; break;
      case 'hover': answer = { kind: 'hover', hover: service.getHover(input.file, input.line!, input.column!) }; break;
      default: throw new Error('Unsupported agent LSP operation');
    }
    const encoded = JSON.stringify(answer);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error('LSP response exceeds 8 MiB; request a smaller page');
    await reply({ id, encoded });
  } catch (cause) { await reply({ id, error: cause instanceof Error ? cause.message : String(cause) }); }
}
async function reply(frame: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(frame) + '\n', error => error ? reject(error) : resolve()));
}
async function main(): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (Buffer.byteLength(line) > 256 * 1024) throw new Error('LSP request exceeds 256 KiB');
    const request = JSON.parse(line);
    if (!Number.isSafeInteger(request.id) || !request.input) throw new Error('Invalid LSP request');
    await execute(request);
  }
}
void main().catch(() => { process.exitCode = 1; }).finally(() => current?.service.dispose());
