import assert from 'node:assert/strict';
import test from 'node:test';
import { guide, guideTopics } from '../lib/guide.js';

test('guideTopics lists the built-in topics', () => {
  const topics = guideTopics();
  for (const expected of ['overview', 'cards', 'datapack', 'bot', 'server', 'errors', 'versions']) {
    assert.ok(topics.includes(expected), `missing topic ${expected}`);
  }
});

test('every guide topic returns substantial markdown', () => {
  for (const topic of guideTopics()) {
    const text = guide(topic);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 100, `topic ${topic} too short`);
  }
});

test('unknown topic falls back to overview', () => {
  assert.equal(guide('does-not-exist'), guide('overview'));
  assert.equal(guide(undefined), guide('overview'));
});
