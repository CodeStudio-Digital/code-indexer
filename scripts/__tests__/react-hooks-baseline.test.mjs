import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReactDiagnostics } from '../react-hooks-baseline.mjs';
import { ESLint } from 'eslint';

test('known findings cannot mask a new rule, site or duplicate violation', () => {
  const baseline = [{ fingerprint: 'existing', count: 1 }];
  assert.equal(compareReactDiagnostics([{ fingerprint: 'existing' }], baseline).regressions.length, 0);
  assert.equal(compareReactDiagnostics([{ fingerprint: 'new-site' }], baseline).regressions.length, 1);
  assert.equal(compareReactDiagnostics([{ fingerprint: 'existing' }, { fingerprint: 'existing' }], baseline).regressions.length, 1);
  assert.equal(compareReactDiagnostics([], baseline).resolved, 1);
});

test('the real recommended plugin diagnoses conditional hooks and missing dependencies', async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(`import { useEffect, useState } from 'react';
export function Broken({ enabled, value }) {
  if (enabled) useState(0);
  useEffect(() => { console.log(value); }, []);
  return null;
}`, { filePath: 'apps/dashboard/__react_guard_probe.tsx' });
  const rules = new Set(result.messages.map(message => message.ruleId));
  assert.ok(rules.has('react-hooks/rules-of-hooks'));
  assert.ok(rules.has('react-hooks/exhaustive-deps'));
});
