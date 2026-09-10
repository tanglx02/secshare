'use strict';

const crypto = require('crypto');

const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

/** scrypt 哈希，格式 scrypt$salt$hash */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN, SCRYPT_OPTS).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  try {
    const calc = crypto.scryptSync(String(plain), salt, KEYLEN, SCRYPT_OPTS);
    const expect = Buffer.from(hash, 'hex');
    if (calc.length !== expect.length) return false;
    return crypto.timingSafeEqual(calc, expect);
  } catch (_) {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { hashPassword, verifyPassword, randomToken };
