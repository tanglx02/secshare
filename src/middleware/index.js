'use strict';

const crypto = require('crypto');
const store = require('../db/store');
const config = require('../config');
const userService = require('../services/user');

/** 极简 Cookie 解析（避免额外依赖） */
function cookieParser(req, res, next) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!k) return;
    try { cookies[k] = decodeURIComponent(v); } catch (_) { cookies[k] = v; }
  });
  req.cookies = cookies;
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${opts.path || '/'}`);
    if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
    const prev = res.getHeader('Set-Cookie');
    const list = prev ? (Array.isArray(prev) ? prev.concat(parts.join('; ')) : [prev, parts.join('; ')]) : [parts.join('; ')];
    res.setHeader('Set-Cookie', list);
  };
  res.clearCookie = (name, opts = {}) => res.cookie(name, '', Object.assign({}, opts, { maxAge: 0 }));
  next();
}

/** CSRF：双重提交 Cookie 方案，兼容未登录请求 */
function csrf(req, res, next) {
  let token = req.cookies['csrf'];
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    res.cookie('csrf', token, { maxAge: 7 * 86400000, httpOnly: false, sameSite: 'Lax' });
  }
  req.csrfToken = token;
  res.locals.csrf = token;

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // multipart/form-data 由文件上传场景使用，此时 body 尚未解析（要等 multer 读取）。
    // 折中策略：携带了 x-csrf-token 请求头就严格校验；未携带时依赖 Cookie 的
    // SameSite=Lax 策略阻断跨站提交（跨站请求既拿不到 csrf Cookie，也带不上登录 Cookie）。
    const isMultipart = /^multipart\/form-data/.test(req.headers['content-type'] || '');
    const headerToken = req.headers['x-csrf-token'];
    const sent = (req.body && req.body._csrf) || headerToken;

    if (isMultipart) {
      if (headerToken && headerToken !== token) {
        return res.status(403).send('CSRF 校验失败，请返回上一页刷新后重试');
      }
      return next();
    }

    if (!sent || sent !== token) {
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({ ok: false, error: 'CSRF 校验失败，请刷新页面后重试' });
      }
      return res.status(403).send('CSRF 校验失败，请返回上一页刷新后重试');
    }
  }
  next();
}

/** 安全响应头 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
}

/** 注入当前用户、站点设置、导航数据到模板 */
function attachGlobals(req, res, next) {
  const contentService = require('../services/content');
  const { getSettings } = require('../services/settings');

  const user = userService.userFromRequest(req);
  req.user = user;

  res.locals.user = user;
  res.locals.isVip = userService.isVip(user);
  res.locals.path = req.path;
  res.locals.fullPath = req.originalUrl || req.path;
  res.locals.query = req.query || {};
  res.locals.currentYear = new Date().getFullYear();
  res.locals.settings = getSettings();
  res.locals.categories = contentService.listCategories();
  res.locals.tags = contentService.listTags().slice(0, 30);
  res.locals.announcements = contentService.activeAnnouncements(4);
  res.locals.friendLinks = contentService.activeLinks();
  res.locals.services = { content: contentService, user: userService };
  res.locals.helpers = require('../utils/helpers');
  res.locals.currentUrl = req.originalUrl;
  res.locals.unreadCount = user ? userService.unreadNoticeCount(user.id) : 0;
  res.locals.setting = (k, d) => res.locals.settings[k] === undefined ? d : res.locals.settings[k];
  res.locals.raw = (s) => String(s === undefined || s === null ? '' : s);
  next();
}

/** 访问统计（PV / UV），跳过静态资源与后台 */
function trackVisit(req, res, next) {
  if (req.method !== 'GET') return next();
  if (/^\/(uploads|css|js|favicon|admin|api)/.test(req.path)) return next();
  if (/\.(css|js|png|jpg|jpeg|gif|webp|svg|ico|map|txt|xml)$/i.test(req.path)) return next();

  const ip = userService.clientIp(req);
  const today = new Date().toISOString().slice(0, 10);
  let day = store.findOne('visits', (v) => v.date === today);
  if (!day) {
    day = store.insert('visits', { date: today, pv: 0, ips: [] });
  }
  day.pv = (day.pv || 0) + 1;
  if (!Array.isArray(day.ips)) day.ips = [];
  const hash = crypto.createHash('md5').update(String(ip) + config.sessionSecret).digest('hex').slice(0, 12);
  if (!day.ips.includes(hash)) {
    day.ips.push(hash);
    if (day.ips.length > 5000) day.ips = day.ips.slice(-5000);
  }
  // 每小时整点前也记录一次，避免进程退出丢数据
  store.save();
  next();
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: '请先登录', needLogin: true });
  const back = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?redirect=${back}`);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: '无权限' });
  return res.redirect(`/admin/login?redirect=${encodeURIComponent(req.originalUrl)}`);
}

/** 404 */
function notFound(req, res) {
  res.status(404);
  if (req.path.startsWith('/api/')) return res.json({ ok: false, error: '接口不存在' });
  return res.render('front/404', { title: '页面不存在' });
}

/** 统一错误处理 */
function errorHandler(err, req, res, next) {
  console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  res.status(status);
  if (req.path.startsWith('/api/')) return res.json({ ok: false, error: err.message });
  return res.render('front/error', { title: '出错了', message: err.message, status });
}

module.exports = {
  cookieParser, csrf, securityHeaders, attachGlobals, trackVisit,
  requireLogin, requireAdmin, notFound, errorHandler,
};
