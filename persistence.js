'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const ENCRYPTION_SECRET = (process.env.STATE_ENCRYPTION_KEY || '').trim();
const enabled = Boolean(DATABASE_URL && ENCRYPTION_SECRET);
let pool = null;
let lastSavedAt = null;
let lastError = null;
let saveChain = Promise.resolve();

function encryptionKey() {
  if (!ENCRYPTION_SECRET) throw new Error('STATE_ENCRYPTION_KEY is required for persistent state');
  return crypto.createHash('sha256').update(ENCRYPTION_SECRET, 'utf8').digest();
}

function encrypt(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64')
  };
}

function decrypt(row) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(clear);
}

async function init() {
  if (!enabled) {
    lastError = DATABASE_URL ? 'STATE_ENCRYPTION_KEY missing' : 'DATABASE_URL missing';
    console.warn('[persistence] Disabled:', lastError);
    return false;
  }
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS zevian_state (
        state_key TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        nonce TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    lastError = null;
    return true;
  } catch (error) {
    lastError = error.message;
    await pool.end().catch(() => {});
    pool = null;
    throw error;
  }
}

async function load() {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT ciphertext, nonce, auth_tag FROM zevian_state WHERE state_key = $1',
    ['main']
  );
  if (!result.rows.length) return null;
  return decrypt(result.rows[0]);
}

function save(snapshot) {
  if (!pool) return Promise.resolve(false);
  saveChain = saveChain.then(async () => {
    const payload = encrypt(snapshot);
    await pool.query(`
      INSERT INTO zevian_state (state_key, ciphertext, nonce, auth_tag, schema_version, updated_at)
      VALUES ($1, $2, $3, $4, 1, NOW())
      ON CONFLICT (state_key) DO UPDATE SET
        ciphertext = EXCLUDED.ciphertext,
        nonce = EXCLUDED.nonce,
        auth_tag = EXCLUDED.auth_tag,
        schema_version = EXCLUDED.schema_version,
        updated_at = NOW()
    `, ['main', payload.ciphertext, payload.nonce, payload.authTag]);
    lastSavedAt = new Date().toISOString();
    lastError = null;
    return true;
  }).catch(error => {
    lastError = error.message;
    console.error('[persistence] Save failed:', error.message);
    return false;
  });
  return saveChain;
}

async function close() {
  if (!pool) return;
  await saveChain;
  await pool.end();
  pool = null;
}

function status() {
  return {
    enabled,
    connected: Boolean(pool),
    encrypted: enabled,
    lastSavedAt,
    error: lastError
  };
}

module.exports = { init, load, save, close, status, __test: { encrypt, decrypt } };
