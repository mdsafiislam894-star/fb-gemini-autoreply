'use strict';

const MAX_REPLY_PARTS = 3;
const MAX_PART_LENGTH = 700;

function normalizeReplyPlan(payload) {
  const policy = String(payload && payload.reply_policy || '').toUpperCase();
  if (policy === 'NO_REPLY') return { policy: 'NO_REPLY', parts: [] };
  const raw = Array.isArray(payload && payload.reply_parts) ? payload.reply_parts : [];
  const legacy = String(payload && payload.suggested_reply || '').trim();
  const source = raw.length ? raw : (legacy ? [legacy] : []);
  const parts = source.map(part => String(part || '').trim()).filter(Boolean).slice(0, MAX_REPLY_PARTS).map(part => part.slice(0, MAX_PART_LENGTH));
  if (!parts.length) return { policy: 'NO_REPLY', parts: [] };
  return { policy: 'SEND', parts };
}

function shouldSkipReplyForDuplicate(messageId, processedIds) {
  if (!messageId) return false;
  if (processedIds.has(messageId)) return true;
  processedIds.add(messageId);
  if (processedIds.size > 5000) processedIds.delete(processedIds.values().next().value);
  return false;
}

module.exports = { normalizeReplyPlan, shouldSkipReplyForDuplicate, MAX_REPLY_PARTS, MAX_PART_LENGTH };
