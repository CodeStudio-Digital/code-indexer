/** Pure mapping tests — TM scope lists → Monaco token categories. */
import { describe, it, expect } from 'vitest';
import { mapScopesToToken } from '../scope-map.js';

describe('mapScopesToToken', () => {
  it('maps common TM scopes to themed Monaco categories', () => {
    expect(mapScopesToToken(['source.toml', 'comment.line.number-sign.toml'])).toBe('comment');
    expect(mapScopesToToken(['source.toml', 'string.quoted.single.basic.line.toml'])).toBe('string');
    expect(mapScopesToToken(['source.toml', 'constant.numeric.integer.toml'])).toBe('number');
    expect(mapScopesToToken(['source.zig', 'keyword.control.zig'])).toBe('keyword');
    expect(mapScopesToToken(['source.zig', 'keyword.operator.comparison.zig'])).toBe('operator');
    expect(mapScopesToToken(['text.html.vue', 'entity.name.tag.template.html.vue'])).toBe('tag');
    expect(mapScopesToToken(['text.html.vue', 'entity.other.attribute-name.html'])).toBe('attribute.name');
    expect(mapScopesToToken(['source.haskell', 'entity.name.function.haskell'])).toBe('function');
    expect(mapScopesToToken(['source.prisma', 'support.type.primitive.prisma'])).toBe('type');
  });

  it('the innermost (most specific) scope wins', () => {
    expect(mapScopesToToken([
      'text.html.vue', 'meta.tag.block.any.html', 'string.quoted.double.html',
    ])).toBe('string');
    // A trailing punctuation scope beats the enclosing string context.
    expect(mapScopesToToken([
      'source.toml', 'string.quoted.basic.toml', 'punctuation.definition.string.toml',
    ])).toBe('delimiter');
  });

  it('diff markup maps to visible categories', () => {
    expect(mapScopesToToken(['source.diff', 'markup.inserted.diff'])).toBe('string');
    expect(mapScopesToToken(['source.diff', 'markup.deleted.diff'])).toBe('invalid');
    expect(mapScopesToToken(['source.diff', 'meta.diff.range.unified'])).toBe('metatag');
  });

  it('unknown scopes and the grammar root fall through to unstyled', () => {
    expect(mapScopesToToken(['source.toml'])).toBe('');
    expect(mapScopesToToken(['source.toml', 'meta.table.toml'])).toBe('');
    expect(mapScopesToToken([])).toBe('');
  });
});
