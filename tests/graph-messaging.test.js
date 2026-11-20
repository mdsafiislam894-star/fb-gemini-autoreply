'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyGraphError,
  hasEmoji,
  withEmoji
} = require('../server');
const {
  classifyGreeting,
  buildGreetingReply,
  classifyActivityQuestion,
  buildAssistantActivityReply
} = require('../assistant-engine');
const {
  normalizeReplyPlan,
  shouldSkipReplyForDuplicate
} = require('../reply-plan');

test('classifies Meta subcode 1893063 as non-retryable PAGE_MESSAGING_RESTRICTED', () => {
  const errorPayload = {
    message: 'Application does not have permission for this action',
    type: 'OAuthException',
    code: 10,
    error_subcode: 1893063,
    is_transient: false,
    fbtrace_id: 'test_trace_123'
  };
  const classified = classifyGraphError(errorPayload, 403);
  assert.equal(classified.category, 'PAGE_MESSAGING_RESTRICTED');
  assert.equal(classified.retryable, false);
  assert.equal(classified.code, 10);
  assert.equal(classified.subcode, 1893063);
  assert.match(classified.action, /Meta Business Suite|Account Quality/i);
});

test('classifies code 190 as non-retryable TOKEN_INVALID', () => {
  const errorPayload = {
    message: 'Error validating access token: Session has expired',
    type: 'OAuthException',
    code: 190
  };
  const classified = classifyGraphError(errorPayload, 400);
  assert.equal(classified.category, 'TOKEN_INVALID');
  assert.equal(classified.retryable, false);
});

test('classifies subcode 2018278 as non-retryable MESSAGING_WINDOW_EXPIRED', () => {
  const errorPayload = {
    message: 'Message outside the 24-hour allowed window',
    type: 'OAuthException',
    code: 10,
    error_subcode: 2018278
  };
  const classified = classifyGraphError(errorPayload, 400);
  assert.equal(classified.category, 'MESSAGING_WINDOW_EXPIRED');
  assert.equal(classified.retryable, false);
});

test('classifies code 10 general permission errors as non-retryable PERMISSION_ERROR', () => {
  const errorPayload = {
    message: 'Requires pages_messaging permission',
    type: 'OAuthException',
    code: 10,
    error_subcode: 2018001
  };
  const classified = classifyGraphError(errorPayload, 403);
  assert.equal(classified.category, 'PERMISSION_ERROR');
  assert.equal(classified.retryable, false);
});

test('classifies transient errors and HTTP 5xx as retryable TRANSIENT_ERROR', () => {
  const transientGraph = {
    message: 'An unexpected error has occurred. Please retry your request later.',
    type: 'OAuthException',
    code: 2,
    is_transient: true
  };
  const c1 = classifyGraphError(transientGraph, 500);
  assert.equal(c1.category, 'TRANSIENT_ERROR');
  assert.equal(c1.retryable, true);

  const serverError = classifyGraphError(null, 503);
  assert.equal(serverError.category, 'TRANSIENT_ERROR');
  assert.equal(serverError.retryable, true);
});

test('enforces at least one emoji on all outgoing user messages', () => {
  assert.equal(hasEmoji('Hey there 🙂'), true);
  assert.equal(hasEmoji('Plain text without emoji'), false);

  const withFallback = withEmoji('Hello there');
  assert.equal(hasEmoji(withFallback), true);
  assert.match(withFallback, /🙂/);

  const alreadyHas = withEmoji('Hello there 😊');
  assert.equal(alreadyHas, 'Hello there 😊');
});

test('Hey produces one natural English reply with emoji', () => {
  const greeting = classifyGreeting('Hey');
  assert.equal(greeting.kind, 'greeting');
  assert.equal(greeting.script, 'English');

  const reply = buildGreetingReply(greeting.script);
  assert.match(reply, /Hey!/);
  assert.equal(hasEmoji(reply), true);
});

test('Ki Koro produces one natural Banglish reply with emoji', () => {
  const activity = classifyActivityQuestion('Ki Koro');
  assert.equal(activity.kind, 'assistant_activity');
  assert.equal(activity.script, 'Banglish');

  const reply = buildAssistantActivityReply(activity.script, 'Ki Koro');
  assert.match(reply, /tomar sathe kotha bolchi/i);
  assert.equal(hasEmoji(reply), true);
});

test('কেমন আছ produces one Bengali reply with emoji', () => {
  const activity = classifyActivityQuestion('কেমন আছ');
  assert.equal(activity.kind, 'assistant_activity');
  assert.equal(activity.script, 'Bengali');

  const reply = buildAssistantActivityReply(activity.script, 'কেমন আছ');
  assert.match(reply, /ভালো আছি/);
  assert.equal(hasEmoji(reply), true);
});

test('সাফি কই triggers owner-specific handling', () => {
  const intent = classifyActivityQuestion('সাফি কই');
  assert.equal(intent.kind, 'owner_activity');
  assert.equal(intent.script, 'Bengali');
});

test('duplicate webhook events are recognized and dropped', () => {
  const processed = new Set();
  const mid = 'mid.1234567890';
  assert.equal(shouldSkipReplyForDuplicate(mid, processed), false);
  assert.equal(shouldSkipReplyForDuplicate(mid, processed), true);
  assert.equal(shouldSkipReplyForDuplicate(mid, processed), true);
});

test('single reply enforcement limits outgoing replies to at most one', () => {
  const multiBubblePlan = {
    reply_policy: 'SEND',
    reply_parts: ['First bubble 🙂', 'Second bubble 😊', 'Third bubble 🚀']
  };
  const normalized = normalizeReplyPlan(multiBubblePlan);
  assert.equal(normalized.policy, 'SEND');
  assert.equal(normalized.parts.length, 1);
  assert.equal(normalized.parts[0], 'First bubble 🙂');
});


// ── Emoji-only detection tests ──

test('isEmojiOnly detects pure emoji messages', () => {
  const { isEmojiOnly } = require('../assistant-engine');
  assert.equal(isEmojiOnly('❤️'), true);
  assert.equal(isEmojiOnly('😂😂😂'), true);
  assert.equal(isEmojiOnly('👍'), true);
  assert.equal(isEmojiOnly('👋🔥'), true);
  assert.equal(isEmojiOnly('🥺💔'), true);
  assert.equal(isEmojiOnly('🙏'), true);
});

test('isEmojiOnly rejects text messages', () => {
  const { isEmojiOnly } = require('../assistant-engine');
  assert.equal(isEmojiOnly('hello'), false);
  assert.equal(isEmojiOnly('ki koris'), false);
  assert.equal(isEmojiOnly('কেমন আছো'), false);
  assert.equal(isEmojiOnly('hello 👋'), false);
  assert.equal(isEmojiOnly(''), false);
  assert.equal(isEmojiOnly(null), false);
});

// ── Emoji reply tests ──

test('buildEmojiReply returns love reply for heart emoji', () => {
  const { buildEmojiReply } = require('../assistant-engine');
  const reply = buildEmojiReply('❤️', 'Banglish');
  assert.ok(reply.length > 0);
  assert.ok(/💖/.test(reply));
});

test('buildEmojiReply returns Bengali reply when script is Bengali', () => {
  const { buildEmojiReply } = require('../assistant-engine');
  const reply = buildEmojiReply('😂', 'Bengali');
  assert.ok(/[\u0980-\u09ff]/.test(reply), 'Reply should contain Bengali script');
});

test('buildEmojiReply returns English reply when script is English', () => {
  const { buildEmojiReply } = require('../assistant-engine');
  const reply = buildEmojiReply('👍', 'English');
  assert.ok(/[a-zA-Z]/.test(reply), 'Reply should contain English text');
  assert.ok(!(/[\u0980-\u09ff]/.test(reply)), 'Reply should not contain Bengali');
});

test('buildEmojiReply handles unknown emoji gracefully', () => {
  const { buildEmojiReply } = require('../assistant-engine');
  const reply = buildEmojiReply('🏈', 'Banglish');
  assert.ok(reply.length > 0);
  assert.ok(/😊/.test(reply));
});

// ── Chit-chat classifier tests ──

test('classifyChitChat detects identity questions', () => {
  const { classifyChitChat } = require('../assistant-engine');
  assert.equal(classifyChitChat('tumi ke?').kind, 'identity');
  assert.equal(classifyChitChat('who are you?').kind, 'identity');
  assert.equal(classifyChitChat('তুমি কে?').kind, 'identity');
  assert.ok(classifyChitChat('tumi ke?').reply.length > 0);
});

test('classifyChitChat detects thanks', () => {
  const { classifyChitChat } = require('../assistant-engine');
  assert.equal(classifyChitChat('thanks').kind, 'thanks');
  assert.equal(classifyChitChat('dhonnobad').kind, 'thanks');
  assert.equal(classifyChitChat('ধন্যবাদ').kind, 'thanks');
});

test('classifyChitChat detects greetings', () => {
  const { classifyChitChat } = require('../assistant-engine');
  assert.equal(classifyChitChat('good morning').kind, 'morning');
  assert.equal(classifyChitChat('good night').kind, 'night');
  assert.equal(classifyChitChat('শুভ সকাল').kind, 'morning');
});

test('classifyChitChat detects bye', () => {
  const { classifyChitChat } = require('../assistant-engine');
  assert.equal(classifyChitChat('bye').kind, 'bye');
  assert.equal(classifyChitChat('take care').kind, 'bye');
});

test('classifyChitChat returns null for normal questions', () => {
  const { classifyChitChat } = require('../assistant-engine');
  assert.equal(classifyChitChat('Bangladesh er capital ki?'), null);
  assert.equal(classifyChitChat('amake help koro'), null);
  assert.equal(classifyChitChat('ki holo?'), null);
});

// ── All chit-chat and emoji replies must have emoji ──

test('all emoji and chit-chat replies contain emoji', () => {
  const { buildEmojiReply, classifyChitChat } = require('../assistant-engine');
  const emojiRe = /\p{Extended_Pictographic}/u;
  
  // Emoji replies
  for (const em of ['❤️', '😂', '👍', '👋', '🔥', '🥺', '🙏', '🏈']) {
    for (const script of ['Bengali', 'English', 'Banglish']) {
      const reply = buildEmojiReply(em, script);
      assert.ok(emojiRe.test(reply), `buildEmojiReply('${em}', '${script}') must have emoji: "${reply}"`);
    }
  }

  // Chit-chat replies
  for (const msg of ['tumi ke?', 'thanks', 'good morning', 'good night', 'bye']) {
    const result = classifyChitChat(msg);
    assert.ok(result && emojiRe.test(result.reply), `classifyChitChat('${msg}') reply must have emoji: "${result?.reply}"`);
  }
});
