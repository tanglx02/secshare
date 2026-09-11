'use strict';

/**
 * 敏感字段加解密（AES-256-GCM）
 * 密钥由 SESSION_SECRET 经 scrypt 派生，按命名空间隔离，避免不同用途共用同一把钥匙。
 * 注意：SESSION_SECRET 变更后旧密文将无法解密，调用方需处理"需重新填写"的降级提示。
 */

const crypto = require('crypto');
const config = require('../config');

const ALGO = 'aes-256-gcm';
const cache = new Map();

function deriveKey(namespace) {
  const ns = String(namespace || 'default');
  if (!cache.has(ns)) {
    cache.set(ns, crypto.scryptSync(String(config.sessionSecret), `secshare-${ns}-v1`, 32));
  }
  return cache.get(ns);
}

function encryptSecret(plain, namespace) {
  const text = String(plain || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(namespace), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decryptSecret(payload, namespace) {
  const raw = String(payload || '');
  if (!raw) return '';
  if (!raw.startsWith('v1:')) return raw; // 兼容历史明文
  const parts = raw.split(':');
  if (parts.length !== 4) return '';
  try {
    const decipher = crypto.createDecipheriv(ALGO, deriveKey(namespace), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch (_) {
    return ''; // 密钥已变更或密文损坏
  }
}

/** 脱敏展示，仅保留首尾各 4 位 */
function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}********${s.slice(-4)}`;
}

module.exports = { encryptSecret, decryptSecret, maskSecret };
