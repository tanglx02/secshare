'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const store = require('../db/store');
const config = require('../config');
const content = require('../services/content');
const userSvc = require('../services/user');
const backup = require('../services/backup');
const pay = require('../services/pay');
const mailer = require('../services/mailer');
const permalink = require('../services/permalink');
const { getSettings, DEFAULTS } = require('../services/settings');
const { hashPassword, verifyPassword } = require('../utils/password');
const helpers = require('../utils/helpers');
const { requireAdmin } = require('../middleware');
const { decorate, postUrl, siteStats } = require('./front');

const router = express.Router();

// ---------------- 上传 ----------------
fs.mkdirSync(path.join(config.paths.uploads, 'images'), { recursive: true });
fs.mkdirSync(path.join(config.paths.uploads, 'files'), { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = file.fieldname === 'image' || /^image\//.test(file.mimetype) ? 'images' : 'files';
    cb(null, path.join(config.paths.uploads, dir));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
    const base = helpers.slugify(path.basename(file.originalname, ext)).slice(0, 40) || 'file';
    cb(null, `${base}-${Date.now().toString(36)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: config.upload.maxSize } });

// 备份恢复专用：只进内存，绝不落到 public 目录（备份含私钥与全站数据）
const uploadMemory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

// ---------------- 登录 ----------------
router.get('/login', (req, res) => {
  if (req.user && req.user.role === 'admin') return res.redirect('/admin');
  res.render('admin/login', {
    layoutTitle: '后台登录', error: null, settings: getSettings(),
    redirect: req.query.redirect || '/admin',
  });
});

router.post('/login', (req, res) => {
  const { account, password, redirect } = req.body;
  const r = userSvc.checkLogin(account, password);
  if (r.error || r.user.role !== 'admin') {
    return res.status(400).render('admin/login', {
      layoutTitle: '后台登录', settings: getSettings(),
      error: r.error || '该账号不是管理员账号',
      redirect: redirect || '/admin',
    });
  }
  const { token } = userSvc.createSession(r.user.id, req);
  userSvc.loginSuccess(r.user, userSvc.clientIp(req));
  res.cookie('sid', token, { maxAge: 7 * 86400000, httpOnly: true, sameSite: 'Lax' });
  res.redirect(redirect && redirect.startsWith('/') ? redirect : '/admin');
});

router.get('/logout', (req, res) => {
  userSvc.destroySession(req.cookies && req.cookies['sid']);
  res.clearCookie('sid');
  res.redirect('/admin/login');
});

// 以下全部需要管理员权限
router.use(requireAdmin);

function adminLocals(extra = {}) {
  const settings = getSettings();
  return Object.assign({
    settings, siteName: settings.siteName,
    helpers, formatSize: helpers.formatSize, formatMoney: helpers.formatMoney,
    formatDate: helpers.formatDate, timeAgo: helpers.timeAgo, compactNumber: helpers.compactNumber,
    postUrl, decorate, activeMenu: '',
  }, extra);
}

// 包装：把 admin 信息注入到 res.locals
router.use((req, res, next) => {
  res.locals.admin = req.user;
  res.locals.activeMenu = '';
  res.locals.path = req.path;
  next();
});

// ---------------- 仪表盘 ----------------
router.get('/', (req, res) => {
  const posts = store.all('posts');
  const users = store.all('users');
  const orders = store.all('orders');
  const paidOrders = orders.filter((o) => o.status === 'paid');
  const revenue = paidOrders.reduce((a, o) => a + (o.amount || 0), 0);

  const today = new Date().toISOString().slice(0, 10);
  const todayVisit = store.findOne('visits', (v) => v.date === today) || { pv: 0, ips: [] };

  // 近 14 天访问趋势
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const v = store.findOne('visits', (x) => x.date === d) || { pv: 0, ips: [] };
    trend.push({ date: d.slice(5), pv: v.pv || 0, uv: (v.ips || []).length });
  }
  const maxPv = Math.max(1, ...trend.map((t) => t.pv));

  const stat = {
    posts: posts.length,
    postsPublished: posts.filter((p) => p.status === 'published').length,
    users: users.length,
    vipUsers: users.filter((u) => userSvc.isVip(u)).length,
    orders: orders.length,
    paidOrders: paidOrders.length,
    revenue,
    todayPv: todayVisit.pv || 0,
    todayUv: (todayVisit.ips || []).length,
    totalPv: store.all('visits').reduce((a, v) => a + (v.pv || 0), 0),
    downloads: posts.reduce((a, p) => a + (p.downloads || 0), 0),
    views: posts.reduce((a, p) => a + (p.views || 0), 0),
    pendingOrders: orders.filter((o) => o.status === 'pending').length,
    comments: store.count('comments'),
  };

  const hotPosts = posts.slice().sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, 8);
  const recentUsers = users.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);
  const recentOrders = orders.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 6);

  res.render('admin/dashboard', adminLocals({
    layoutTitle: '仪表盘', activeMenu: 'dashboard',
    stat, trend, maxPv, hotPosts, recentUsers, recentOrders,
    catMap: catMap(),
  }));
});

function catMap() {
  const m = {};
  store.all('categories').forEach((c) => { m[c.id] = c; });
  return m;
}

// ---------------- 资源管理 ----------------
router.get('/posts', (req, res) => {
  const { type, status, q, cat, page = 1 } = req.query;
  const result = content.queryPosts({
    type: type || undefined,
    categoryId: cat || undefined,
    keyword: q,
    status: status || 'published',
    includeAll: status === 'all' || !status,
    sort: 'update',
    page: Number(page) || 1,
    perPage: 20,
  });
  res.render('admin/posts', adminLocals({
    layoutTitle: '资源管理', activeMenu: 'posts',
    posts: result.list, pager: result.pager, catMap: catMap(),
    filter: { type: type || '', status: status || 'all', q: q || '', cat: cat || '' },
    query: req.query,
  }));
});

router.get('/posts/new', (req, res) => {
  res.render('admin/post-edit', adminLocals({
    layoutTitle: '新增内容', activeMenu: 'posts',
    post: { type: 'software', accessLevel: 'vip', status: 'published', tags: [], downloadLines: [], pointsPrice: 0, price: 0 },
    isNew: true, catMap: catMap(),
  }));
});

router.get('/posts/:id/edit', (req, res) => {
  const post = store.findById('posts', req.params.id);
  if (!post) return res.status(404).send('内容不存在');
  res.render('admin/post-edit', adminLocals({
    layoutTitle: '编辑内容', activeMenu: 'posts',
    post, isNew: false, catMap: catMap(),
  }));
});

router.post('/posts/save', (req, res) => {
  const b = req.body;
  const id = b.id;
  const lines = [];
  const lineNames = [].concat(b.lineName || []);
  const lineUrls = [].concat(b.lineUrl || []);
  const lineCodes = [].concat(b.lineCode || []);
  lineUrls.forEach((url, i) => {
    if (String(url).trim()) lines.push({ name: String(lineNames[i] || `线路${i + 1}`), url: String(url).trim(), code: String(lineCodes[i] || '').trim() });
  });

  const data = {
    title: String(b.title || '').trim().slice(0, 200),
    slug: helpers.slugify(b.slug || '').slice(0, 80),
    type: ['software', 'doc', 'news'].includes(b.type) ? b.type : 'software',
    categoryId: b.categoryId ? Number(b.categoryId) : null,
    status: b.status === 'draft' ? 'draft' : 'published',
    accessLevel: ['free', 'login', 'points', 'vip', 'paid'].includes(b.accessLevel) ? b.accessLevel : 'vip',
    pointsPrice: Number(b.pointsPrice || 0),
    price: helpers.parseMoney(b.price || 0),
    version: String(b.version || '').slice(0, 40),
    platform: String(b.platform || '').slice(0, 60),
    language: String(b.language || '').slice(0, 20),
    size: String(b.size || '').slice(0, 20),
    official: String(b.official || '').slice(0, 300),
    author: String(b.author || '站长').slice(0, 40),
    cover: String(b.cover || '').slice(0, 300),
    summary: String(b.summary || '').slice(0, 500),
    content: String(b.content || ''),
    tags: String(b.tags || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12),
    downloadUrl: lines[0] ? lines[0].url : String(b.downloadUrl || '').trim(),
    downloadCode: lines[0] ? lines[0].code : String(b.downloadCode || '').trim(),
    downloadLines: lines,
    unzipPassword: String(b.unzipPassword || '').slice(0, 60),
    fileHash: String(b.fileHash || '').slice(0, 120),
    top: b.top === 'on' || b.top === 'true',
    featured: b.featured === 'on' || b.featured === 'true',
    recommended: b.recommended === 'on' || b.recommended === 'true',
  };

  if (!data.title) return res.status(400).send('标题不能为空');

  content.ensureTags(data.tags);
  let post;
  if (id) {
    post = store.update('posts', id, data);
    if (!post) return res.status(404).send('内容不存在');
  } else {
    post = store.insert('posts', Object.assign(data, {
      views: 0, downloads: 0, publishedAt: new Date().toISOString(),
    }));
  }
  // 别名兜底 + 唯一化（链接结构依赖 slug）
  const finalSlug = permalink.uniqueSlug(post.slug || permalink.generateSlug(post.title, post.id), post.id);
  if (finalSlug !== post.slug) {
    post.slug = finalSlug;
    store.save();
  }
  content.syncTagCounts();
  res.redirect('/admin/posts');
});

/** 一键为所有缺少别名的内容生成 slug */
router.post('/posts/gen-slugs', (req, res) => {
  const n = permalink.generateAllSlugs();
  res.redirect('/admin/posts?msg=' + encodeURIComponent(n > 0 ? `已为 ${n} 条内容生成链接别名` : '所有内容都已有链接别名'));
});

router.post('/posts/:id/delete', (req, res) => {
  store.removeWhere('comments', (c) => String(c.postId) === String(req.params.id));
  store.remove('posts', req.params.id);
  content.syncTagCounts();
  res.redirect('/admin/posts');
});

router.post('/posts/batch', (req, res) => {
  const ids = [].concat(req.body.ids || []);
  const action = req.body.action;
  ids.forEach((id) => {
    if (action === 'delete') store.remove('posts', id);
    else if (action === 'publish') store.update('posts', id, { status: 'published' });
    else if (action === 'draft') store.update('posts', id, { status: 'draft' });
    else if (action === 'top') { const p = store.findById('posts', id); if (p) { p.top = !p.top; store.save(); } }
    else if (action === 'featured') { const p = store.findById('posts', id); if (p) { p.featured = !p.featured; store.save(); } }
  });
  content.syncTagCounts();
  res.redirect(req.get('referer') || '/admin/posts');
});

// ---------------- 分类 ----------------
router.get('/categories', (req, res) => {
  res.render('admin/categories', adminLocals({
    layoutTitle: '分类管理', activeMenu: 'categories',
    list: content.listCategories(),
    counts: store.all('posts').reduce((a, p) => { a[p.categoryId] = (a[p.categoryId] || 0) + 1; return a; }, {}),
  }));
});

router.post('/categories/save', (req, res) => {
  const b = req.body;
  const data = {
    name: String(b.name || '').trim().slice(0, 40),
    slug: helpers.slugify(b.slug || b.name || '').slice(0, 60),
    parentId: b.parentId ? Number(b.parentId) : null,
    icon: String(b.icon || '📦').slice(0, 8),
    sort: Number(b.sort || 100),
    description: String(b.description || '').slice(0, 200),
  };
  if (!data.name) return res.status(400).send('分类名称不能为空');
  if (!data.slug) data.slug = `cat-${Date.now().toString(36)}`;
  if (b.id) store.update('categories', b.id, data);
  else store.insert('categories', data);
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  store.remove('categories', req.params.id);
  res.redirect('/admin/categories');
});

// ---------------- 标签 ----------------
router.get('/tags', (req, res) => {
  content.syncTagCounts();
  res.render('admin/tags', adminLocals({
    layoutTitle: '标签管理', activeMenu: 'tags', list: content.listTags(),
  }));
});

router.post('/tags/save', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).send('标签名不能为空');
  if (!store.findOne('tags', (t) => t.name === name)) store.insert('tags', { name, slug: name, count: 0 });
  res.redirect('/admin/tags');
});

router.post('/tags/:id/delete', (req, res) => {
  store.remove('tags', req.params.id);
  res.redirect('/admin/tags');
});

// ---------------- 评论 ----------------
router.get('/comments', (req, res) => {
  const list = store.all('comments').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin/comments', adminLocals({
    layoutTitle: '评论管理', activeMenu: 'comments',
    list: list.map((c) => Object.assign({}, c, { post: store.findById('posts', c.postId) })),
  }));
});

router.post('/comments/:id/delete', (req, res) => {
  store.remove('comments', req.params.id);
  res.redirect('/admin/comments');
});

// ---------------- 用户 ----------------
router.get('/users', (req, res) => {
  const { q, vip, page = 1 } = req.query;
  let users = store.all('users');
  if (q) {
    const kw = String(q).toLowerCase();
    users = users.filter((u) => (u.username || '').toLowerCase().includes(kw) || (u.email || '').toLowerCase().includes(kw));
  }
  if (vip === '1') users = users.filter((u) => userSvc.isVip(u));
  users.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const pager = helpers.paginate(users.length, Number(page) || 1, 20);
  res.render('admin/users', adminLocals({
    layoutTitle: '用户管理', activeMenu: 'users',
    users: users.slice(pager.offset, pager.offset + pager.perPage),
    pager, filter: { q: q || '', vip: vip || '' },
    editUser: req.query.edit ? store.findById('users', req.query.edit) : null,
    isVip: userSvc.isVip.bind(userSvc),
  }));
});

router.post('/users/save', (req, res) => {
  const b = req.body;
  const user = store.findById('users', b.id);
  if (!user) return res.status(404).send('用户不存在');
  const patch = { nickname: String(b.nickname || user.username).slice(0, 30), email: String(b.email || '').slice(0, 100), points: Number(b.points || 0), status: b.status === 'banned' ? 'banned' : 'active', vipLevel: Number(b.vipLevel || 0) };
  if (b.vipExpireAt) patch.vipExpireAt = new Date(b.vipExpireAt).toISOString();
  else if (b.vipLevel === '0') patch.vipExpireAt = null;
  if (b.newPassword) patch.password = hashPassword(b.newPassword);
  store.update('users', b.id, patch);
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle-ban', (req, res) => {
  const user = store.findById('users', req.params.id);
  if (user && user.role !== 'admin') {
    user.status = user.status === 'banned' ? 'active' : 'banned';
    store.save();
  }
  res.redirect(req.get('referer') || '/admin/users');
});

router.post('/users/:id/grant-vip', (req, res) => {
  const user = store.findById('users', req.params.id);
  const days = Number(req.body.days || 30);
  if (user) {
    const base = userSvc.isVip(user) && user.vipExpireAt ? new Date(user.vipExpireAt).getTime() : Date.now();
    user.vipExpireAt = new Date(base + days * 86400000).toISOString();
    user.vipLevel = Math.max(1, Number(user.vipLevel || 0));
    store.save();
  }
  res.redirect(req.get('referer') || '/admin/users');
});

// ---------------- 订单 ----------------
router.get('/orders', (req, res) => {
  const { status, page = 1 } = req.query;
  let orders = store.all('orders');
  if (status) orders = orders.filter((o) => o.status === status);
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const pager = helpers.paginate(orders.length, Number(page) || 1, 20);
  const users = {};
  store.all('users').forEach((u) => { users[u.id] = u; });
  res.render('admin/orders', adminLocals({
    layoutTitle: '订单管理', activeMenu: 'orders',
    orders: orders.slice(pager.offset, pager.offset + pager.perPage),
    pager, users, filter: { status: status || '' },
    revenue: store.all('orders').filter((o) => o.status === 'paid').reduce((a, o) => a + (o.amount || 0), 0),
  }));
});

router.post('/orders/:id/confirm', (req, res) => {
  const order = store.findById('orders', req.params.id);
  if (order) userSvc.fulfillOrder(order, req.body.tradeNo || 'MANUAL');
  res.redirect(req.get('referer') || '/admin/orders');
});

router.post('/orders/:id/cancel', (req, res) => {
  const order = store.findById('orders', req.params.id);
  if (order && order.status === 'pending') { order.status = 'cancelled'; store.save(); }
  res.redirect(req.get('referer') || '/admin/orders');
});

router.post('/orders/:id/delete', (req, res) => {
  store.remove('orders', req.params.id);
  res.redirect('/admin/orders');
});

// ---------------- 会员套餐 ----------------
router.get('/plans', (req, res) => {
  res.render('admin/plans', adminLocals({
    layoutTitle: '会员套餐', activeMenu: 'plans',
    plans: userSvc.listPlans(false),
  }));
});

router.post('/plans/save', (req, res) => {
  const b = req.body;
  const data = {
    name: String(b.name || '').trim().slice(0, 30),
    days: Number(b.days || 30),
    price: helpers.parseMoney(b.price || 0),
    originalPrice: helpers.parseMoney(b.originalPrice || 0),
    level: Number(b.level || 1),
    sort: Number(b.sort || 100),
    active: b.active === 'on' || b.active === 'true',
    recommend: b.recommend === 'on' || b.recommend === 'true',
    badge: String(b.badge || '').slice(0, 20),
    features: String(b.features || '').split('\n').map((s) => s.trim()).filter(Boolean),
  };
  if (!data.name) return res.status(400).send('套餐名称不能为空');
  if (b.id) store.update('plans', b.id, data);
  else store.insert('plans', data);
  res.redirect('/admin/plans');
});

router.post('/plans/:id/delete', (req, res) => {
  store.remove('plans', req.params.id);
  res.redirect('/admin/plans');
});

// ---------------- 广告 ----------------
router.get('/ads', (req, res) => {
  const ads = store.all('ads');
  res.render('admin/ads', adminLocals({
    layoutTitle: '广告管理', activeMenu: 'ads',
    ads,
    positions: [
      { key: 'home_top', label: '首页顶部横幅' },
      { key: 'sidebar', label: '侧边栏' },
      { key: 'detail_top', label: '详情页顶部' },
      { key: 'float', label: '全站右下角悬浮' },
    ],
    clicks: ads.reduce((a, x) => a + (x.clicks || 0), 0),
    views: ads.reduce((a, x) => a + (x.views || 0), 0),
  }));
});

router.post('/ads/save', (req, res) => {
  const b = req.body;
  const data = {
    name: String(b.name || '').trim().slice(0, 50),
    position: b.position || 'sidebar',
    type: b.type === 'html' ? 'html' : 'image',
    image: String(b.image || '').slice(0, 300),
    link: String(b.link || '').slice(0, 300),
    html: String(b.html || ''),
    text: String(b.text || '').slice(0, 100),
    price: helpers.parseMoney(b.price || 0),
    startAt: b.startAt || null,
    endAt: b.endAt || null,
    active: b.active === 'on' || b.active === 'true',
  };
  if (!data.name) return res.status(400).send('广告名称不能为空');
  if (b.id) store.update('ads', b.id, data);
  else store.insert('ads', Object.assign(data, { views: 0, clicks: 0 }));
  res.redirect('/admin/ads');
});

router.post('/ads/:id/delete', (req, res) => {
  store.remove('ads', req.params.id);
  res.redirect('/admin/ads');
});

// ---------------- 公告 ----------------
router.get('/announcements', (req, res) => {
  res.render('admin/announcements', adminLocals({
    layoutTitle: '公告管理', activeMenu: 'announcements',
    list: store.all('announcements').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  }));
});

router.post('/announcements/save', (req, res) => {
  const b = req.body;
  const data = {
    title: String(b.title || '').trim().slice(0, 80),
    content: String(b.content || '').slice(0, 1000),
    pinned: b.pinned === 'on',
    active: b.active === 'on',
  };
  if (!data.title) return res.status(400).send('公告标题不能为空');
  if (b.id) store.update('announcements', b.id, data);
  else store.insert('announcements', data);
  res.redirect('/admin/announcements');
});

router.post('/announcements/:id/delete', (req, res) => {
  store.remove('announcements', req.params.id);
  res.redirect('/admin/announcements');
});

// ---------------- 友情链接 ----------------
router.get('/links', (req, res) => {
  res.render('admin/links', adminLocals({
    layoutTitle: '友情链接', activeMenu: 'links',
    list: store.all('links').sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100)),
  }));
});

router.post('/links/save', (req, res) => {
  const b = req.body;
  const data = {
    name: String(b.name || '').trim().slice(0, 40),
    url: String(b.url || '').trim().slice(0, 200),
    sort: Number(b.sort || 100),
    active: b.active === 'on',
  };
  if (!data.name || !data.url) return res.status(400).send('名称与链接不能为空');
  if (b.id) store.update('links', b.id, data);
  else store.insert('links', data);
  res.redirect('/admin/links');
});

router.post('/links/:id/delete', (req, res) => {
  store.remove('links', req.params.id);
  res.redirect('/admin/links');
});

// ---------------- 系统设置 ----------------
const BOOL_KEYS = [
  'commentsEnabled', 'registerEnabled', 'registerNeedInvite', 'downloadNeedLogin',
  'adsEnabled', 'vipEnabled', 'shopEnabled', 'payMock',
  'alipayEnabled', 'backupAutoEnabled', 'backupIncludeUploads',
  'registerNeedEmailVerify', 'mailEchoCode', 'searchPageNoindex', 'enableStructuredData',
];

router.get('/settings', (req, res) => {
  const samplePost = store.all('posts')[0];
  res.render('admin/settings', adminLocals({
    layoutTitle: '系统设置', activeMenu: 'settings',
    s: getSettings(), boolKeys: BOOL_KEYS,
    permalinkStructures: permalink.STRUCTURES,
    permalinkSample: samplePost ? permalink.postPath(samplePost) : '/resource/示例别名',
    dbSize: (() => { try { return fs.statSync(config.paths.dbFile).size; } catch (_) { return 0; } })(),
  }));
});

router.post('/settings', (req, res) => {
  const b = req.body;
  // 复选框未勾选时不会提交，因此由表单显式声明本次提交涉及哪些布尔字段，
  // 避免「局部提交」把未参与表单的开关静默关闭。
  const boolList = String(b.__bools || '').split(',').map((s) => s.trim()).filter(Boolean);
  const patch = {};
  Object.keys(DEFAULTS).forEach((k) => {
    if (BOOL_KEYS.includes(k)) {
      if (boolList.includes(k)) patch[k] = b[k] === 'on' || b[k] === 'true';
      return;
    }
    if (b[k] !== undefined) patch[k] = typeof DEFAULTS[k] === 'number' ? Number(b[k]) : String(b[k]);
  });
  store.setSettings(patch);
  res.redirect('/admin/settings?msg=' + encodeURIComponent('设置已保存'));
});

// ---------------- 统计 ----------------
router.get('/stats', (req, res) => {
  const visits = store.all('visits').slice().sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
  const posts = store.all('posts');
  const topPosts = posts.slice().sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 15);
  const topDownloads = posts.slice().sort((a, b) => (b.downloads || 0) - (a.downloads || 0)).slice(0, 15);
  res.render('admin/stats', adminLocals({
    layoutTitle: '数据统计', activeMenu: 'stats',
    visits, topPosts, topDownloads, siteStat: siteStats(),
    maxPv: Math.max(1, ...visits.map((v) => v.pv || 0)),
    catMap: catMap(),
  }));
});

// ---------------- 全站备份 ----------------
router.get('/backup', (req, res) => {
  res.render('admin/backup', adminLocals({
    layoutTitle: '全站备份', activeMenu: 'backup',
    files: backup.listBackups(),
    footprint: backup.siteFootprint(),
    dir: backup.backupDir(),
    s: getSettings(),
  }));
});

router.post('/backup/create', (req, res) => {
  try {
    const scope = req.body.scope === 'data' ? 'data' : 'full';
    const r = backup.createBackup({ includeUploads: scope === 'full' });
    const tip = `备份完成：${r.name} · ${(r.size / 1024).toFixed(1)} KB · 含 ${r.fileCount} 个文件 · 压缩率 ${(r.compressRate * 100).toFixed(0)}%`;
    res.redirect('/admin/backup?msg=' + encodeURIComponent(tip));
  } catch (err) {
    res.redirect('/admin/backup?err=' + encodeURIComponent('备份失败：' + err.message));
  }
});

/** 立即打包下载（同时保留一份到服务器） */
router.get('/backup/pack', (req, res) => {
  try {
    const r = backup.createBackup({ includeUploads: req.query.scope !== 'data' });
    res.download(r.path, r.name);
  } catch (err) {
    res.status(500).send('打包失败：' + err.message);
  }
});

/** 仅下载数据库文件（JSON，便于直接查看） */
router.get('/backup/download', (req, res) => {
  store.flush();
  res.download(config.paths.dbFile, `db-${new Date().toISOString().slice(0, 10)}.json`);
});

router.get('/backup/file/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const full = path.join(backup.backupDir(), name);
  if (!fs.existsSync(full)) return res.status(404).send('文件不存在');
  res.download(full);
});

router.post('/backup/restore', (req, res) => {
  uploadMemory.single('file')(req, res, (err) => {
    if (err) return res.redirect('/admin/backup?err=' + encodeURIComponent('上传失败：' + err.message));
    try {
      // 未上传文件时：按文件名恢复服务器上已有的备份
      if (!req.file) {
        const picked = path.basename(String((req.body && req.body.name) || '').trim());
        if (!picked) return res.redirect('/admin/backup?err=' + encodeURIComponent('请选择要恢复的备份文件'));
        const full = path.join(backup.backupDir(), picked);
        if (!fs.existsSync(full)) return res.redirect('/admin/backup?err=' + encodeURIComponent('备份文件不存在：' + picked));
        const rr = backup.restoreBackup(full);
        return res.redirect('/admin/backup?msg=' + encodeURIComponent(`恢复完成：数据文件${rr.db ? '已还原' : '未包含'}，上传文件 ${rr.files} 个（恢复前的快照已保留）`));
      }
      const name = String(req.file.originalname || '');
      if (name.endsWith('.json')) {
        // 兼容旧版纯 JSON 备份
        const parsed = JSON.parse(req.file.buffer.toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || !parsed.meta) throw new Error('数据文件格式不正确');
        backup.createBackup({ isAuto: false });
        Object.assign(store.data, parsed);
        store.flush();
        return res.redirect('/admin/backup?msg=' + encodeURIComponent('数据已恢复（恢复前的全站快照已自动保留）'));
      }
      const r = backup.restoreBackup(req.file.buffer);
      return res.redirect('/admin/backup?msg=' + encodeURIComponent(`恢复完成：数据文件${r.db ? '已还原' : '未包含'}，上传文件 ${r.files} 个`));
    } catch (e) {
      return res.redirect('/admin/backup?err=' + encodeURIComponent('恢复失败：' + e.message));
    }
  });
});

router.post('/backup/delete/:name', (req, res) => {
  try { backup.deleteBackup(req.params.name); } catch (_) { /* ignore */ }
  res.redirect('/admin/backup?msg=' + encodeURIComponent('备份已删除'));
});

router.post('/backup/auto', (req, res) => {
  const b = req.body;
  store.setSettings({
    backupAutoEnabled: b.backupAutoEnabled === 'on' || b.backupAutoEnabled === 'true',
    backupIntervalHours: Math.max(1, Number(b.backupIntervalHours) || 24),
    backupKeep: Math.max(1, Number(b.backupKeep) || 7),
    backupIncludeUploads: b.backupIncludeUploads === 'on' || b.backupIncludeUploads === 'true',
    backupDir: String(b.backupDir || '').trim(),
  });
  res.redirect('/admin/backup?msg=' + encodeURIComponent('自动备份策略已保存'));
});

// ---------------- 支付设置 ----------------
router.get('/payment', (req, res) => {
  const cfg = pay.getPayConfig();
  res.render('admin/payment', adminLocals({
    layoutTitle: '支付设置', activeMenu: 'payment',
    cfg,
    suggested: pay.suggestedUrls(getSettings().siteUrl),
    logs: store.all('paylogs').slice().reverse().slice(0, 20),
    paidOrders: store.all('orders')
      .filter((o) => o.status === 'paid')
      .sort((a, b) => new Date(b.paidAt || b.updatedAt || b.createdAt) - new Date(a.paidAt || a.updatedAt || a.createdAt))
      .slice(0, 8),
  }));
});

router.post('/payment', (req, res) => {
  try {
    pay.savePayConfig(req.body);
    res.redirect('/admin/payment?msg=' + encodeURIComponent('支付配置已保存'));
  } catch (err) {
    res.redirect('/admin/payment?err=' + encodeURIComponent(err.message));
  }
});

router.post('/payment/test', async (req, res) => {
  const r = await pay.testConnection();
  res.redirect('/admin/payment?' + (r.ok ? 'msg=' : 'err=') + encodeURIComponent((r.ok ? '连接正常：' : '连接失败：') + r.message));
});

// ---------------- 邮件服务（SMTP） ----------------
router.get('/mail', (req, res) => {
  res.render('admin/mail', adminLocals({
    layoutTitle: '邮件设置', activeMenu: 'mail',
    cfg: mailer.getMailConfig(),
    codes: mailer.recentCodes(15),
    s: getSettings(),
  }));
});

router.post('/mail', (req, res) => {
  try {
    mailer.saveMailConfig(req.body);
    res.redirect('/admin/mail?msg=' + encodeURIComponent('邮件配置已保存'));
  } catch (err) {
    res.redirect('/admin/mail?err=' + encodeURIComponent(err.message));
  }
});

router.post('/mail/test', async (req, res) => {
  const to = String(req.body.testTo || '').trim();
  if (to) {
    try {
      const s = getSettings();
      await mailer.sendMail({
        to,
        subject: `【${s.siteName}】邮件服务测试`,
        html: `<p>这是一封测试邮件，能收到即表示 SMTP 配置正确。</p>
               <p>发送时间：${new Date().toLocaleString('zh-CN')}</p>
               <p style="color:#9ca3af;font-size:12px;">本邮件由 ${s.siteName} 后台自动发送。</p>`,
      });
      return res.redirect('/admin/mail?msg=' + encodeURIComponent(`测试邮件已发送到 ${to}，请查收（含垃圾箱）`));
    } catch (err) {
      return res.redirect('/admin/mail?err=' + encodeURIComponent('发送失败：' + err.message));
    }
  }
  const r = await mailer.testConnection();
  res.redirect('/admin/mail?' + (r.ok ? 'msg=' : 'err=') + encodeURIComponent((r.ok ? '连接正常：' : '连接失败：') + r.message));
});

// ---------------- 上传接口 ----------------
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: '未接收到文件' });
    const rel = `/uploads/${req.file.destination.includes('images') ? 'images' : 'files'}/${req.file.filename}`;
    res.json({ ok: true, url: rel, size: req.file.size, name: req.file.originalname });
  });
});

module.exports = router;
