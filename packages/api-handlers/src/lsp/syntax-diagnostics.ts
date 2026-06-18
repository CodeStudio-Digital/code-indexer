import { extname } from 'node:path';
import type Parser from 'web-tree-sitter';
import type { DiagnosticItem } from '@mcp/api-bus';
import {
  createParser,
  getGrammarForExtension,
} from '@mcp/indexer/indexer/tree-sitter/index.js';

const parsers = new Map<string, Parser>();

async function parserFor(wasmFile: string): Promise<Parser> {
  const cached = parsers.get(wasmFile);
  if (cached) return cached;
  const parser = await createParser(wasmFile);
  parsers.set(wasmFile, parser);
  return parser;
}

function rangeFor(node: Parser.SyntaxNode): DiagnosticItem['range'] {
  const start = {
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  };
  const end = {
    line: node.endPosition.row + 1,
    column: node.endPosition.column + 1,
  };
  if (end.line === start.line && end.column <= start.column) {
    end.column = start.column + 1;
  }
  return { start, end };
}

function messageFor(node: Parser.SyntaxNode): string {
  if (node.isMissing) return `Syntax error: missing ${node.type}`;
  return 'Syntax error';
}

export async function syntaxDiagnosticsFor(
  file: string,
  content: string,
): Promise<DiagnosticItem[]> {
  const ext = extname(file).replace(/^\./, '').toLowerCase();
  const grammar = getGrammarForExtension(ext);
  if (!grammar) return [];

  const parser = await parserFor(grammar.wasmFile);
  const tree = parser.parse(content);
  try {
    const root = tree.rootNode;
    if (!root.hasError) return [];
    const diagnostics: DiagnosticItem[] = [];

    const visit = (node: Parser.SyntaxNode): void => {
      if (diagnostics.length >= 50) return;
      if (node.isError || node.isMissing) {
        diagnostics.push({
          file,
          range: rangeFor(node),
          severity: 'error',
          message: messageFor(node),
          source: 'tree-sitter',
          code: node.type,
        });
        return;
      }
      if (!node.hasError) return;
      for (const child of node.namedChildren) visit(child);
    };

    visit(root);
    return diagnostics;
  } finally {
    tree.delete();
  }
}
