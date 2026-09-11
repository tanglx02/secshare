'use strict';

/**
 * 邮件服务 + 邮箱验证码
 * - SMTP 配置存在站点设置里，密码用 AES-256-GCM 加密落盘（命名空间 smtp）
 * - 未配置 SMTP 时降级：验证码写入服务端日志，管理员可在后台查看，方便内网/调试环境
 * - 验证码带频控：同邮箱 60 秒一条、1 小时 5 条；同 IP 1 小时 10 条；10 分钟有效，最多试 5 次
 */

const nodemailer = require('nodemailer');

const store = require('../db/store');
const { getSettings } = require('./settings');
const { encryptSecret, decryptSecret } = require('../utils/secret');

const NS = 'smtp';
const CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_INTERVAL_MS = 60 * 1000;
const EMAIL_HOURLY_LIMIT = 5;
const IP_HOURLY_LIMIT = 10;
const MAX_ATTEMPTS = 5;

// ============================================================
// 配置
// ============================================================

function getMailConfig() {
  const s = getSettings();
  const enc = store.getSetting('smtpPassEnc', '');
  const port = Number(s.smtpPort) || 465;
  return {
    enabled: s.mailEnabled === true,
    host: String(s.smtpHost || '').trim(),
    port,
    secure: s.smtpSecure !== false && port === 465,
    user: String(s.smtpUser || '').trim(),
    pass: decryptSecret(enc, NS),
    fromName: String(s.smtpFromName || s.siteName || 'SecShare').trim(),
    fromEmail: String(s.smtpFromEmail || s.smtpUser || '').trim(),
    hasPass: !!enc,
    keyBroken: !!enc && !decryptSecret(enc, NS),
    needVerify: s.registerNeedEmailVerify === true,
  };
}

function isMailReady() {
  const c = getMailConfig();
  return c.enabled && !!c.host && !!c.user && !!c.pass;
}

function saveMailConfig(input) {
  const port = Number(input.smtpPort) || 465;
  store.setSettings({
    mailEnabled: !!input.mailEnabled,
    smtpHost: String(input.smtpHost || '').trim(),
    smtpPort: port,
    smtpSecure: input.smtpSecure === 'on' || input.smtpSecure === 'true' || port === 465,
    smtpUser: String(input.smtpUser || '').trim(),
    smtpFromName: String(input.smtpFromName || '').trim(),
    smtpFromEmail: String(input.smtpFromEmail || '').trim(),
    registerNeedEmailVerify: !!input.registerNeedEmailVerify,
    registerIpDailyLimit: Math.max(0, Number(input.registerIpDailyLimit) || 0),
  });
  if (input.clearPass === '1') {
    store.setSetting('smtpPassEnc', '');
    return;
  }
  const raw = String(input.smtpPass || '').trim();
  if (raw) store.setSetting('smtpPassEnc', encryptSecret(raw, NS));
}

// ============================================================
// 发信
// ============================================================

function createTransport() {
  const c = getMailConfig();
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

async function sendMail({ to, subject, html, text }) {
  if (!isMailReady()) throw new Error('邮件服务未配置或未启用');
  const c = getMailConfig();
  const transport = createTransport();
  try {
    const info = await transport.sendMail({
      from: `"${c.fromName}" <${c.fromEmail || c.user}>`,
      to,
      subject,
      text: text || undefined,
      html,
    });
    return { ok: true, messageId: info.messageId };
  } finally {
    try { transport.close(); } catch (_) { /* ignore */ }
  }
}

/** 连通性自检 */
async function testConnection() {
  const c = getMailConfig();
  if (!c.host) return { ok: false, message: '未填写 SMTP 服务器地址' };
  if (!c.user) return { ok: false, message: '未填写 SMTP 账号' };
  if (!c.pass) return { ok: false, message: c.keyBroken ? '密码解密失败（SESSION_SECRET 变更过），请重新填写' : '未填写 SMTP 密码' };
  try {
    const transport = createTransport();
    await transport.verify();
    transport.close();
    return { ok: true, message: `连接成功（${c.host}:${c.port}，${c.secure ? 'SSL' : 'STARTTLS'}）` };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// ============================================================
// 验证码
// ============================================================

function countRecent(list, since) {
  return list.filter((r) => new Date(r.createdAt).getTime() > since).length;
}

/**
 * 生成并发送验证码
 * @returns {{ ok:boolean, message?:string, code?:string, devMode?:boolean }}
 */
async function sendVerifyCode({ email, ip, purpose = 'register' }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return { ok: false, message: '邮箱格式不正确' };
  if (store.findOne('users', (u) => (u.email || '').toLowerCase() === addr)) {
    return { ok: false, message: '该邮箱已被注册' };
  }

  const now = Date.now();
  const all = store.col('emailcodes');
  const forEmail = all.filter((r) => r.email === addr);

  const last = forEmail.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (last && now - new Date(last.createdAt).getTime() < EMAIL_INTERVAL_MS) {
    const wait = Math.ceil((EMAIL_INTERVAL_MS - (now - new Date(last.createdAt).getTime())) / 1000);
    return { ok: false, message: `发送太频繁，请 ${wait} 秒后再试` };
  }
  if (countRecent(forEmail, now - 3600000) >= EMAIL_HOURLY_LIMIT) {
    return { ok: false, message: '该邮箱今日发送次数过多，请稍后再试' };
  }
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  if (ip && !isLoopback && countRecent(all.filter((r) => r.ip === ip), now - 3600000) >= IP_HOURLY_LIMIT) {
    return { ok: false, message: '当前网络发送次数过多，请稍后再试' };
  }

  // 生成 6 位数字
  const code = String(Math.floor(100000 + Math.random() * 900000));
  store.insert('emailcodes', {
    email: addr, code, ip: ip || '', purpose,
    attempts: 0, used: false,
    expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
  });

  // 清理过期记录
  store.removeWhere('emailcodes', (r) => new Date(r.createdAt).getTime() < now - 86400000);

  const settings = getSettings();
  const subject = `【${settings.siteName}】注册验证码：${code}`;
  const html = renderCodeMail({ siteName: settings.siteName, code, minutes: 10, siteUrl: settings.siteUrl });

  if (!isMailReady()) {
    // 未配置 SMTP：降级为日志 + 后台可见，便于内网使用
    console.log(`[mail] 邮件服务未配置，${addr} 的验证码为：${code}（10 分钟内有效）`);
    return { ok: true, devMode: true, code, message: '站点暂未配置邮件服务，验证码已输出到服务端日志' };
  }

  await sendMail({
    to: addr,
    subject,
    html,
    text: `${settings.siteName} 注册验证码：${code}，10 分钟内有效。`,
  });
  return { ok: true, devMode: false, message: '验证码已发送到邮箱' };
}

/** 校验验证码 */
function verifyCode(email, code) {
  const addr = String(email || '').trim().toLowerCase();
  const input = String(code || '').trim();
  if (!addr || !input) return { ok: false, message: '请填写邮箱与验证码' };

  const rows = store.col('emailcodes')
    .filter((r) => r.email === addr && !r.used)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const rec = rows[0];
  if (!rec) return { ok: false, message: '请先获取验证码' };
  if (new Date(rec.expiresAt).getTime() < Date.now()) return { ok: false, message: '验证码已过期，请重新获取' };
  if ((rec.attempts || 0) >= MAX_ATTEMPTS) return { ok: false, message: '尝试次数过多，请重新获取验证码' };

  if (rec.code !== input) {
    rec.attempts = (rec.attempts || 0) + 1;
    store.save();
    return { ok: false, message: `验证码不正确（还可尝试 ${MAX_ATTEMPTS - rec.attempts} 次）` };
  }

  rec.used = true;
  rec.usedAt = new Date().toISOString();
  store.save();
  return { ok: true };
}

/** 后台查看最近验证码（仅管理员） */
function recentCodes(limit = 20) {
  return store.col('emailcodes')
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

// 简单的 HTML 邮件模板
function renderCodeMail({ siteName, code, minutes, siteUrl }) {
  const digits = String(code).split('');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:32px 0;">
<tr><td align="center">
  <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,.08);">
    <tr><td style="background:linear-gradient(120deg,#0f172a,#1e3a8a,#0e7490);padding:26px 32px;color:#fff;">
      <div style="font-size:18px;font-weight:700;letter-spacing:.3px;">${escapeHtml(siteName)}</div>
      <div style="font-size:13px;color:#c7d2fe;margin-top:6px;">邮箱验证</div>
    </td></tr>
    <tr><td style="padding:30px 32px;">
      <p style="margin:0 0 18px;font-size:15px;color:#1f2937;">您好，您正在进行邮箱验证，验证码为：</p>
      <div style="text-align:center;margin:22px 0;">
        <span style="display:inline-block;font-size:32px;font-weight:800;letter-spacing:10px;color:#1d4ed8;background:#eff6ff;border:1px dashed #bfdbfe;border-radius:10px;padding:14px 22px 14px 32px;">${digits.join('')}</span>
      </div>
      <p style="margin:0 0 8px;font-size:13.5px;color:#4b5563;">验证码 ${minutes} 分钟内有效，请勿泄露给他人。</p>
      <p style="margin:0;font-size:13px;color:#9ca3af;">如果这不是您本人的操作，忽略本邮件即可。</p>
    </td></tr>
    <tr><td style="padding:16px 32px 24px;border-top:1px solid #f1f5f9;">
      <div style="font-size:12px;color:#9ca3af;line-height:1.8;">
        本邮件由系统自动发送，请勿直接回复。<br>
        ${siteUrl ? `<a href="${escapeHtml(siteUrl)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(siteUrl)}</a>` : ''}
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  getMailConfig, saveMailConfig, isMailReady, testConnection,
  sendMail, sendVerifyCode, verifyCode, recentCodes,
};
