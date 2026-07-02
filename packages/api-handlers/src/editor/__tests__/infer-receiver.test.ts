import { describe, it, expect } from 'vitest';
import { inferReceiverClass } from '../completion/snippets/infer-receiver.js';

describe('inferReceiverClass — PHP', () => {
  it('infers from `new` assignment', () => {
    const content = '<?php\n$svc = new LoyaltyService();\n$svc->';
    expect(inferReceiverClass(content, '$svc', 3, 'php')).toBe('LoyaltyService');
  });

  it('infers from a function parameter type hint', () => {
    const content = '<?php\nfunction handle(SyncService $svc, array $data) {\n    $svc->\n}';
    expect(inferReceiverClass(content, '$svc', 3, 'php')).toBe('SyncService');
  });

  it('infers from promoted constructor properties', () => {
    const content = '<?php\nclass C {\n  public function __construct(private BillingClient $billing) {}\n  public function run() {\n    $this->x = 1;\n    $billing->\n  }\n}';
    expect(inferReceiverClass(content, '$billing', 6, 'php')).toBe('BillingClient');
  });

  it('nearest assignment before the cursor wins over an earlier param hint', () => {
    const content = '<?php\nfunction f(Foo $x) {\n  $x = new Bar();\n  $x->\n}';
    expect(inferReceiverClass(content, '$x', 4, 'php')).toBe('Bar');
  });

  it('ignores scalar type hints', () => {
    const content = '<?php\nfunction f(string $name) {\n  $name->\n}';
    expect(inferReceiverClass(content, '$name', 3, 'php')).toBeNull();
  });
});

describe('inferReceiverClass — TS/JS', () => {
  it('infers from new-assignment and annotation', () => {
    expect(inferReceiverClass('const api = new ApiClient();\napi.', 'api', 2, 'typescript')).toBe('ApiClient');
    expect(inferReceiverClass('function f(api: ApiClient) {\n  api.\n}', 'api', 2, 'typescript')).toBe('ApiClient');
  });

  it('infers from an `as Cls` cast and drops namespace qualifiers', () => {
    expect(inferReceiverClass('const x = raw as models.User;\nx.', 'x', 2, 'typescript')).toBe('User');
  });

  it('ignores primitive annotations', () => {
    expect(inferReceiverClass('const n: number = 1;\nn.', 'n', 2, 'typescript')).toBeNull();
  });
});

describe('inferReceiverClass — Python', () => {
  it('infers from annotation and constructor call', () => {
    expect(inferReceiverClass('svc: SyncService = build()\nsvc.', 'svc', 2, 'python')).toBe('SyncService');
    expect(inferReceiverClass('svc = SyncService()\nsvc.', 'svc', 2, 'python')).toBe('SyncService');
  });

  it('ignores builtins', () => {
    expect(inferReceiverClass('n: int = 1\nn.', 'n', 2, 'python')).toBeNull();
  });
});

describe('inferReceiverClass — guards', () => {
  it('unknown language and empty receiver return null, never throw', () => {
    expect(inferReceiverClass('x = X()', 'x', 1, 'ruby')).toBeNull();
    expect(inferReceiverClass('anything', '', 1, 'php')).toBeNull();
  });
});
