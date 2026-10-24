import { describe, expect, it, vi } from 'vitest';
import { compile } from 'monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js';
import {
  CSHARP_EXTRA_RULES,
  JAVA_EXTRA_RULES,
  enrichJavaCsharpHighlighting,
  enrichedCsharp,
  enrichedJava,
} from '../java-csharp-highlight.js';

function firstRule(rules: typeof JAVA_EXTRA_RULES, source: string): unknown {
  for (const [pattern, action] of rules as Array<[RegExp, unknown]>) {
    const match = new RegExp(pattern.source).exec(source);
    if (match?.index === 0) return action;
  }
  return null;
}

describe('enriched Java/C# grammars', () => {
  it('replaces both lazy tokenizer factories once per Monaco instance', () => {
    const registerTokensProviderFactory = vi.fn((_language: string, _factory: { create(): unknown }) => ({ dispose() {} }));
    const monaco = { languages: { registerTokensProviderFactory } } as never;

    enrichJavaCsharpHighlighting(monaco);
    enrichJavaCsharpHighlighting(monaco);

    expect(registerTokensProviderFactory).toHaveBeenCalledTimes(2);
    expect(registerTokensProviderFactory.mock.calls.map(([language]) => language)).toEqual(['java', 'csharp']);
  });

  it('compiles both extended grammars through Monarch', () => {
    expect(compile('java', enrichedJava() as never).start).toBe('root');
    expect(compile('csharp', enrichedCsharp() as never).start).toBe('root');
  });

  it('classifies Java namespaces, declarations, calls and properties', () => {
    expect(firstRule(JAVA_EXTRA_RULES, 'import java.util.ArrayList')).toEqual([
      'keyword.java', 'white', 'entity.name.namespace', 'entity.name.type',
    ]);
    expect(firstRule(JAVA_EXTRA_RULES, 'record ProducerAwardIntervals')).toEqual([
      'keyword.java', 'white', 'entity.name.type.class',
    ]);
    expect(firstRule(JAVA_EXTRA_RULES, '.values(')).toEqual([
      'delimiter.java', 'white', 'entity.name.function.member',
    ]);
    expect(firstRule(JAVA_EXTRA_RULES, '.producers')).toEqual([
      'delimiter.java', 'white', 'variable.other.property',
    ]);
  });

  it('classifies C# namespaces, declarations, calls, properties and attributes', () => {
    expect(firstRule(CSHARP_EXTRA_RULES, 'using Newtonsoft.Json.Linq')).toEqual([
      'keyword.cs', 'white', 'entity.name.namespace',
    ]);
    expect(firstRule(CSHARP_EXTRA_RULES, 'sealed class AssetEditingScope')).toBeNull();
    expect(firstRule(CSHARP_EXTRA_RULES, 'class AssetEditingScope')).toEqual([
      'keyword.cs', 'white', 'entity.name.type.class',
    ]);
    expect(firstRule(CSHARP_EXTRA_RULES, '.StopAssetEditing(')).toEqual([
      'delimiter.cs', 'white', 'entity.name.function.member',
    ]);
    expect(firstRule(CSHARP_EXTRA_RULES, '.Ordinal')).toEqual([
      'delimiter.cs', 'white', 'variable.other.property',
    ]);
    expect(firstRule(CSHARP_EXTRA_RULES, '[SerializeField]')).toEqual([
      'delimiter.square.cs', 'white', 'entity.name.decorator',
    ]);
  });
});
