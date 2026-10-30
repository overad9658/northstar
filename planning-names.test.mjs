import assert from 'node:assert/strict';
import test from 'node:test';
import { randomName } from './planning-service.mjs';

test('guest names are an adjective, an animal and a number from 10 to 99', () => {
  const pattern = /^(Bright|Calm|Clever|Curious|Kind|Nimble|Quiet|Swift) (Badger|Falcon|Fox|Otter|Panda|Raven|Tiger|Wolf) ([1-9]\d)$/;
  const numbers = new Set();
  for (let index = 0; index < 500; index += 1) {
    const match = randomName().match(pattern);
    assert.ok(match, 'name matches the pattern');
    numbers.add(Number(match[3]));
  }
  assert.ok(Math.min(...numbers) >= 10 && Math.max(...numbers) <= 99);
});
