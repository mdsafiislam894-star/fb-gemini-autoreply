'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyRelayIntent,
  buildRelayAcknowledgement,
  canSendWifeProactive,
  makeProactiveSchedule,
  isProactiveScheduleValid,
  isTaskReminderDue
} = require('../assistant-engine');

const NOW = Date.parse('2026-11-20T03:00:00.000Z'); // 09:00 Asia/Dhaka

test('recognizes the exact Banglish college relay phrase as a task', () => {
  const task = classifyRelayIntent('Safire Bole Dibi J Kalke Sir College a Jaite Bolche', NOW);
  assert.equal(task.isRelay, true);
  assert.equal(task.dueDate, '2026-11-21');
  assert.equal(task.timeSpecified, false);
  assert.equal(task.dueAt, Date.parse('2026-11-21T03:00:00.000Z')); // default 09:00 Asia/Dhaka
  assert.equal(task.dueTimeSource, 'default');
});

test('recognizes Bengali and English message-relay requests', () => {
  assert.equal(classifyRelayIntent('সাফিকে বলে দিও কাল স্যার কলেজে যেতে বলেছেন', NOW).isRelay, true);
  assert.equal(classifyRelayIntent('Please tell Safi to call me tomorrow', NOW).isRelay, true);
});

test('does not invent a due date or time for an undated relay', () => {
  const task = classifyRelayIntent('Safi ke bole dio amar phone korte', NOW);
  assert.equal(task.isRelay, true);
  assert.equal(task.dueDate, null);
  assert.equal(task.dueAt, null);
  assert.equal(task.timeSpecified, false);
});

test('understands explicit clock time and keeps its source', () => {
  const task = classifyRelayIntent('Safi ke bole dio kalke 10:30 e college jete', NOW);
  assert.equal(task.dueAt, Date.parse('2026-11-21T04:30:00.000Z'));
  assert.equal(task.timeSpecified, true);
  assert.equal(task.dueTimeSource, 'user');
});

test('builds a short acknowledgement in the sender script', () => {
  const task = { dueDate: '2026-11-21', dueAt: Date.parse('2026-11-21T03:00:00.000Z'), timeSpecified: false };
  assert.match(buildRelayAcknowledgement('Banglish (Romanized Bengali)', task), /Safi-ke janacchi/);
  assert.match(buildRelayAcknowledgement('Bengali Script', task), /জানিয়ে রাখছি/);
  assert.match(buildRelayAcknowledgement('English', task), /I'll let Safi know/);
});

test('only an explicitly tagged wife with a recent inbound can be proactive-eligible', () => {
  const now = NOW;
  const conv = { lastUserAt: now - 60_000 };
  assert.equal(canSendWifeProactive({ relationship: 'wife', affectionate: true, lastProactiveAt: 0 }, conv, now), true);
  assert.equal(canSendWifeProactive({ relationship: 'friend', affectionate: true, lastProactiveAt: 0 }, conv, now), false);
  assert.equal(canSendWifeProactive({ relationship: 'wife', affectionate: false, lastProactiveAt: 0 }, conv, now), false);
  assert.equal(canSendWifeProactive({ relationship: 'wife', affectionate: true, lastProactiveAt: now - 60 * 60 * 1000 }, conv, now), false);
  assert.equal(canSendWifeProactive({ relationship: 'wife', affectionate: true, lastProactiveAt: 0 }, { lastUserAt: now - 25 * 60 * 60 * 1000 }, now), false);
});

test('proactive schedule is invalidated by a newer inbound and expires at 24 hours', () => {
  const profile = { relationship: 'wife', affectionate: true, lastProactiveAt: 0 };
  const conversation = { lastUserAt: NOW - 1000 };
  const schedule = makeProactiveSchedule(profile, conversation, 'Ektu pore kotha bolbo Sona 💙', NOW);
  assert.ok(schedule);
  assert.equal(isProactiveScheduleValid(schedule, conversation, profile, NOW + 11 * 60 * 1000), true);
  assert.equal(isProactiveScheduleValid(schedule, { lastUserAt: NOW + 1 }, profile, NOW + 11 * 60 * 1000), false);
  assert.equal(isProactiveScheduleValid(schedule, conversation, profile, NOW + 24 * 60 * 60 * 1000), false);
  assert.equal(makeProactiveSchedule({ relationship: 'friend', affectionate: true }, conversation, 'hello', NOW), null);
});

test('interprets Bangla night time as 24-hour local time', () => {
  const task = classifyRelayIntent('Safi ke bole dio kalke rat 10ta e college jete', NOW);
  assert.equal(task.dueAt, Date.parse('2026-11-21T16:00:00.000Z'));
  assert.equal(task.timeSpecified, true);
});

test('recognizes direct call-back requests as owner relay tasks', () => {
  assert.equal(classifyRelayIntent('Call me tomorrow please', NOW).isRelay, true);
});

test('due reminder respects snooze, sent state, and retry backoff', () => {
  const task = { status: 'OPEN', dueAt: NOW - 1000, reminderDelivery: { status: 'PENDING', nextAttemptAt: NOW - 1000 } };
  assert.equal(isTaskReminderDue(task, NOW), true);
  task.snoozedUntil = NOW + 60_000;
  assert.equal(isTaskReminderDue(task, NOW), false);
  task.snoozedUntil = 0;
  task.reminderDelivery.status = 'SENT';
  assert.equal(isTaskReminderDue(task, NOW), false);
  task.reminderDelivery.status = 'PENDING';
  task.reminderDelivery.nextAttemptAt = NOW + 60_000;
  assert.equal(isTaskReminderDue(task, NOW), false);
});

test('distinguishes a question to ZEVIAN from a personal question about the owner', () => {
  const { classifyActivityQuestion } = require('../assistant-engine');
  assert.deepEqual(classifyActivityQuestion('Ki koro?'), { kind: 'assistant_activity', script: 'Banglish' });
  assert.deepEqual(classifyActivityQuestion('Ki koris'), { kind: 'assistant_activity', script: 'Banglish' });
  assert.deepEqual(classifyActivityQuestion('What are you doing?'), { kind: 'assistant_activity', script: 'English' });
  assert.deepEqual(classifyActivityQuestion('Ki obostha?'), { kind: 'assistant_activity', script: 'Banglish' });
  assert.deepEqual(classifyActivityQuestion('Koi achis?'), { kind: 'assistant_activity', script: 'Banglish' });
  assert.deepEqual(classifyActivityQuestion('Safi koi achis?'), { kind: 'owner_activity', script: 'Banglish' });
  assert.deepEqual(classifyActivityQuestion('Safi ki kortese?'), { kind: 'owner_activity', script: 'Banglish' });
  assert.deepEqual(classifyActivityQuestion('সাফি স্যার এখন কী করছেন?'), { kind: 'owner_activity', script: 'Bengali' });
  assert.deepEqual(classifyActivityQuestion('Hi'), { kind: 'other', script: 'English' });
});

test('builds a natural activity reply in the incoming script', () => {
  const { buildAssistantActivityReply } = require('../assistant-engine');
  assert.match(buildAssistantActivityReply('Banglish', 'Ki koris?'), /tomar sathe kotha bolchi/i);
  assert.match(buildAssistantActivityReply('Banglish', 'Koi achis?'), /ekhanei achi/i);
  assert.match(buildAssistantActivityReply('English'), /chatting with you/i);
  assert.match(buildAssistantActivityReply('Bengali'), /তোমার সঙ্গে কথা বলছি/);
});
