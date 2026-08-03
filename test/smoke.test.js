const test = require('node:test');
const assert = require('node:assert');

test('smoke: node --test runner works', () => {
  assert.strictEqual(1 + 1, 2);
});
