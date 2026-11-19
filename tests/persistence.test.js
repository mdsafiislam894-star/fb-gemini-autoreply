'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STATE_ENCRYPTION_KEY = 'test-only-secret-for-aes-gcm-roundtrip-1234567890';
process.env.DATABASE_URL = '';

const { __test } = require('../persistence');

test('encrypted snapshots round-trip without changing JSON data', () => {
  const input = {
    ownerPresence: 'offline',
    ownerTasks: [{ id: 'TK-201', status: 'OPEN', title: 'কলেজে যেতে হবে' }],
    contactProfiles: { 'psid-1': { relationship: 'wife', affectionate: true } }
  };
  const encrypted = __test.encrypt(input);
  assert.notEqual(encrypted.ciphertext, JSON.stringify(input));
  assert.deepEqual(__test.decrypt({
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag
  }), input);
});

test('tampered encrypted snapshots fail authentication', () => {
  const encrypted = __test.encrypt({ secret: 'do-not-leak' });
  const tampered = {
    ciphertext: Buffer.from('tampered').toString('base64'),
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag
  };
  assert.throws(() => __test.decrypt(tampered));
});
