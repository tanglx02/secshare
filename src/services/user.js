'use strict';

const store = require('../db/store');
const config = require('../config');
const { hashPassword, verifyPassword, randomToken } = require('../utils/password');

const ROLE_ADMIN = 'admin';
const ROLE_USER = 'user';

// ============ 用户 ============
function findByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  return store.findOne('users', (r) => (r.username || '').toLowerCase() === u || (r.email || '').toLowerCase() === u);
}

function findById(id) { return store.findById('users', id); }

function register({ username, email, password, inviteCode, ip }) {
  const settings = store.data.settings || {};
  if (findByUsername(username)) return { error: '该用户名或邮箱已被注册' };
  if (email && store.findOne('users', (u) => (u.email || '').toLowerCase() === String(email).toLowerCase())) {
    return { error: '该邮箱已被注册' };
  }
  const needInvite = settings.registerNeedInvite === true;
  if (needInvite && String(inviteCode || '') !== String(settings.inviteCode || '')) {
    return { error: '邀请码不正确' };
  }
  const user = store.insert('users', {
    username: String(username).trim(),
    email: String(email || '').trim(),
    password: hashPassword(password),
    role: ROLE_USER,
    status: 'active',
    nickname: String(username).trim(),
    avatar: '',
    points: Number(settings.pointsPerRegister ?? 10),
    vipLevel: 0,
    vipExpireAt: null,
    registerIp: ip || '',
    lastLoginAt: null,
    lastLoginIp: '',
  });
  return { user };
}

function checkLogin(account, password) {
  const user = findByUsername(account);
  if (!user) return { error: '账号或密码错误' };
  if (!verifyPassword(password, user.password)) return { error: '账号或密码错误' };
  if (user.status === 'banned') return { error: '该账号已被封禁，如有疑问请联系管理员' };
  return { user };
}

function loginSuccess(user, ip) {
  user.lastLoginAt = new Date().toISOString();
  user.lastLoginIp = ip || '';
  store.save();
}

function isVip(user) {
  if (!user) return false;
  if (user.role === ROLE_ADMIN) return true;
  if (!user.vipLevel || user.vipLevel <= 0) return false;
  if (!user.vipExpireAt) return true; // 永久
  return new Date(user.vipExpireAt).getTime() > Date.now();
}

/**
 * 判断某用户对资源的访问权限
 * accessLevel: free 免费 / login 登录可下载 / points 积分 / vip 会员 / paid 单独付费
 */
function checkAccess(user, post) {
  const level = post.accessLevel || (store.data.settings.downloadNeedLogin === false ? 'free' : 'vip');
  if (level === 'free') return { ok: true };
  if (!user) return { ok: false, reason: 'login', level };
  if (user.role === ROLE_ADMIN) return { ok: true };
  if (level === 'login') return { ok: true };
  if (level === 'vip') {
    return isVip(user)
      ? { ok: true }
      : { ok: false, reason: 'vip', level };
  }
  if (level === 'points') {
    const need = Number(post.pointsPrice || 0);
    return (user.points || 0) >= need
      ? { ok: true, costPoints: need }
      : { ok: false, reason: 'points', level, need, have: user.points || 0 };
  }
  if (level === 'paid') {
    const bought = store.findOne('orders', (o) => o.type === 'post'
      && String(o.postId) === String(post.id) && String(o.userId) === String(user.id) && o.status === 'paid');
    return bought ? { ok: true } : { ok: false, reason: 'paid', level, price: post.price || 0 };
  }
  return { ok: true };
}

// ============ 会话 ============
function createSession(userId, req) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400000).toISOString();
  store.insert('sessions', {
    token, userId, expiresAt,
    ip: clientIp(req),
    ua: (req.headers['user-agent'] || '').slice(0, 200),
  });
  return { token, expiresAt };
}

function getSession(token) {
  if (!token) return null;
  const s = store.findOne('sessions', (x) => x.token === token);
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) {
    store.remove('sessions', s.id);
    return null;
  }
  return s;
}

function destroySession(token) {
  if (!token) return;
  store.removeWhere('sessions', (s) => s.token === token);
}

function userFromRequest(req) {
  const token = req.cookies && req.cookies['sid'];
  const session = getSession(token);
  if (!session) return null;
  const user = findById(session.userId);
  if (!user || user.status === 'banned') return null;
  return user;
}

function cleanupSessions() {
  store.removeWhere('sessions', (s) => new Date(s.expiresAt).getTime() < Date.now());
}

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

// ============ 会员套餐 / 订单 ============
function listPlans(onlyActive = false) {
  const plans = store.all('plans').sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100) || (a.price || 0) - (b.price || 0));
  return onlyActive ? plans.filter((p) => p.active !== false) : plans;
}

function createOrder({ userId, type, planId, postId, amount, payMethod, remark }) {
  const order = store.insert('orders', {
    orderNo: genOrderNo(),
    userId, type: type || 'vip', planId: planId || null, postId: postId || null,
    amount: Number(amount) || 0,
    status: 'pending',
    payMethod: payMethod || 'manual',
    remark: remark || '',
    paidAt: null,
    tradeNo: '',
  });
  return order;
}

function genOrderNo() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `SS${stamp}${p(Math.floor(Math.random() * 10000), 4)}`;
}

/** 支付成功后交付：开通会员 / 解锁资源 */
function fulfillOrder(order, tradeNo) {
  if (!order || order.status === 'paid') return order;
  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  if (tradeNo) order.tradeNo = tradeNo;

  if (order.type === 'vip' && order.planId) {
    const plan = store.findById('plans', order.planId);
    const user = findById(order.userId);
    if (plan && user) {
      const days = Number(plan.days || 30);
      const base = isVip(user) && user.vipExpireAt ? new Date(user.vipExpireAt).getTime() : Date.now();
      user.vipExpireAt = new Date(base + days * 86400000).toISOString();
      user.vipLevel = Math.max(Number(user.vipLevel || 0), Number(plan.level || 1));
      store.insert('notices', {
        userId: user.id, title: '会员开通成功',
        content: `您已成功开通「${plan.name}」，有效期至 ${user.vipExpireAt.slice(0, 10)}。`,
        read: false,
      });
    }
  }
  store.save();
  return order;
}

function userOrders(userId) {
  return store.find('orders', (o) => String(o.userId) === String(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function listNotices(userId, limit = 20) {
  return store.find('notices', (n) => String(n.userId) === String(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

function unreadNoticeCount(userId) {
  return store.count('notices', (n) => String(n.userId) === String(userId) && !n.read);
}

// ============ 收藏 / 下载记录 ============
function toggleFavorite(userId, postId) {
  const exists = store.findOne('favorites', (f) => String(f.userId) === String(userId) && String(f.postId) === String(postId));
  if (exists) { store.remove('favorites', exists.id); return false; }
  store.insert('favorites', { userId, postId });
  return true;
}

function isFavorited(userId, postId) {
  return !!store.findOne('favorites', (f) => String(f.userId) === String(userId) && String(f.postId) === String(postId));
}

function userFavorites(userId) {
  const favs = store.find('favorites', (f) => String(f.userId) === String(userId));
  return favs.map((f) => store.findById('posts', f.postId)).filter(Boolean);
}

function recordDownload({ userId, postId, ip }) {
  store.insert('downloads', { userId: userId || null, postId, ip: ip || '' });
}

function userDownloads(userId, limit = 50) {
  const rows = store.find('downloads', (d) => String(d.userId) === String(userId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(String(r.postId))) continue;
    seen.add(String(r.postId));
    const post = store.findById('posts', r.postId);
    if (post) out.push(Object.assign({}, r, { post }));
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  ROLE_ADMIN, ROLE_USER,
  findByUsername, findById, register, checkLogin, loginSuccess, isVip, checkAccess,
  createSession, getSession, destroySession, userFromRequest, cleanupSessions, clientIp,
  listPlans, createOrder, genOrderNo, fulfillOrder, userOrders, listNotices, unreadNoticeCount,
  toggleFavorite, isFavorited, userFavorites, recordDownload, userDownloads,
};
