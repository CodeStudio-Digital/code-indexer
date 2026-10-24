import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleSpecifiers } from './asar-closure.mjs';

test('follows module imports and worker dependencies without treating prose or methods as imports', () => {
  const source = `
    import { a } from './first.js';
    export * from './second.js';
    import('./third.js');
    const a = require('plain');
    require.resolve('worker-dependency');
    module.require('node:fs');
    state.require('active');
    const sample = "require('example-only')";
    // require('comment')
    /* import 'another-comment'; */
  `;
  assert.deepEqual(moduleSpecifiers(source), ['./first.js', './second.js', './third.js', 'plain', 'worker-dependency', 'node:fs']);
});
