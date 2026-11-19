'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeReplyPlan, shouldSkipReplyForDuplicate } = require('../reply-plan');

test('sends only one reply even when the model proposes multiple bubbles', () => {
  assert.deepEqual(normalizeReplyPlan({ reply_policy: 'SEND', reply_parts: ['Aito bose aci 🙂', 'Tui ki koris?'] }), { policy: 'SEND', parts: ['Aito bose aci 🙂'] });
});
test('limits every incoming message to a single outgoing reply', () => {
  assert.equal(normalizeReplyPlan({ reply_parts: ['One'] }).parts.length, 1);
  assert.equal(normalizeReplyPlan({ reply_parts: ['One', 'Two', 'Three', 'Four'] }).parts.length, 1);
});
test('honors explicit no-reply policy', () => {
  assert.deepEqual(normalizeReplyPlan({ reply_policy: 'NO_REPLY', reply_parts: ['do not send'] }), { policy: 'NO_REPLY', parts: [] });
});
test('empty or invalid reply plan safely becomes no-reply', () => {
  assert.deepEqual(normalizeReplyPlan({ reply_parts: ['', '  ', null] }), { policy: 'NO_REPLY', parts: [] });
});
test('retains compatibility with legacy single suggested_reply', () => {
  assert.deepEqual(normalizeReplyPlan({ suggested_reply: 'Hello 🙂' }), { policy: 'SEND', parts: ['Hello 🙂'] });
});
test('trims each part to the supported length', () => {
  assert.equal(normalizeReplyPlan({ reply_parts: ['x'.repeat(900)] }).parts[0].length, 700);
});
test('duplicate message ids are only accepted once', () => {
  const ids = new Set();
  assert.equal(shouldSkipReplyForDuplicate('mid.1', ids), false);
  assert.equal(shouldSkipReplyForDuplicate('mid.1', ids), true);
  assert.equal(shouldSkipReplyForDuplicate(null, ids), false);
});
