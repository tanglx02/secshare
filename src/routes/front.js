'use strict';

const express = require('express');
const store = require('../db/store');
const content = require('../services/content');
const userSvc = require('../services/user');
const pay = require('../services/pay');
const permalink = require('../services/permalink');
const mailer = require('../services/mailer');
const { getSettings } = require('../services/settings');
const { esc, formatDate, timeAgo, compactNumber, formatSize, formatMoney, parseMoney, excerpt, paginate, slugify } = require('../utils/helpers');
const md = require('../utils/markdown');

const pageRouter = express.Router();
const apiRouter = express.Router();

function baseLocals(extra = {}) {
  const settings = getSettings();
  return Object.assign({
    title: settings.siteName,
    settings,
    pageTitle: '',
    desc: settings.siteDescription,
    keywords: settings.siteKeywords,
    canonical: '',
    ogImage: settings.ogImage || '',
    ogType: 'website',
    robots: '',
  }, extra);
}

/** 文章链接统一走 permalink 服务：后台改了链接结构，全站内部链接自动跟随 */
function postUrl(post, category) {
  if (!post) return '/';
  try {
    return permalink.postUrl(post, category);
  } catch (_) {
    return `/resource/${post.slug || post.id}`;
  }
}

/** 拼接绝对地址（canonical / og:url 使用） */
function absoluteUrl(req, path) {
  const base = (getSettings().siteUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const p = String(path || '/');
  return base + (p.startsWith('/') ? p : `/${p}`);
}

function decorate(post) {
  const cat = store.findById('categories', post.categoryId);
  return Object.assign({}, post, {
    url: postUrl(post, cat),
    categoryName: cat ? cat.name : '未分类',
    categorySlug: cat ? cat.slug : '',
    categoryIcon: cat ? cat.icon : '📦',
    summaryText: post.summary || excerpt(post.content, 140),
    dateText: formatDate(post.publishedAt || post.createdAt),
    agoText: timeAgo(post.publishedAt || post.createdAt),
    viewsText: compactNumber(post.views || 0),
    downloadsText: compactNumber(post.downloads || 0),
  });
}

function accessLabel(level) {
  return {
    free: { text: '免费下载', cls: 'tag-free' },
    login: { text: '登录下载', cls: 'tag-login' },
    points: { text: '积分兑换', cls: 'tag-points' },
    vip: { text: 'VIP 专享', cls: 'tag-vip' },
    paid: { text: '付费资源', cls: 'tag-paid' },
  }[level || 'free'] || { text: '免费下载', cls: 'tag-free' };
}

// ============================================================
// 前台页面
// ============================================================

// 首页
pageRouter.get('/', (req, res) => {
  const featured = content.queryPosts({ featured: true, perPage: 6, sort: 'new' }).list.map(decorate);
  const latest = content.queryPosts({ type: 'software', perPage: 12, sort: 'new' }).list.map(decorate);
  const hot = content.queryPosts({ perPage: 10, sort: 'download' }).list.map(decorate);
  const docs = content.queryPosts({ type: 'doc', perPage: 6, sort: 'new' }).list.map(decorate);
  const recommend = content.queryPosts({ recommended: true, perPage: 8, sort: 'hot' }).list.map(decorate);

  res.render('front/index', baseLocals({
    title: `${getSettings().siteName} - ${getSettings().siteSubtitle}`,
    pageTitle: '首页',
    featured, latest, hot, docs, recommend,
    stats: siteStats(),
    accessLabel,
    postUrl,
  }));
});

// 资源列表 / 搜索
pageRouter.get('/resources', (req, res) => {
  const { type, cat, tag, q, sort = 'new', page = 1, level } = req.query;
  const category = cat ? content.getCategoryBySlug(cat) : null;
  const tagRow = tag ? content.getTagBySlug(tag) : null;

  const result = content.queryPosts({
    type: type || undefined,
    categoryId: category ? category.id : undefined,
    tag: tagRow ? tagRow.name : undefined,
    keyword: q,
    level: level || undefined,
    sort, page: Number(page) || 1, perPage: 12,
  });

  const typeName = { software: '软件工具', doc: '学习资料' }[type] || '全部资源';
  let pageTitle = typeName;
  if (category) pageTitle = category.name;
  if (tagRow) pageTitle = `标签：${tagRow.name}`;
  if (q) pageTitle = `搜索：${q}`;

  res.render('front/list', baseLocals({
    title: `${pageTitle} - ${getSettings().siteName}`,
    pageTitle,
    desc: category ? category.description : getSettings().siteDescription,
    robots: (getSettings().searchPageNoindex !== false
      && (type || cat || tag || q || level || (sort && sort !== 'new'))) ? 'noindex,follow' : '',
    posts: result.list.map(decorate),
    pager: result.pager,
    currentCategory: category,
    currentTag: tagRow,
    currentType: type || '',
    currentSort: sort,
    keyword: q || '',
    baseQuery: buildQuery(req.query, { page: null }),
    accessLabel,
    postUrl,
  }));
});

pageRouter.get('/category/:slug', (req, res) => {
  const category = content.getCategoryBySlug(req.params.slug);
  if (!category) return res.status(404).render('front/404', baseLocals({ title: '分类不存在', pageTitle: '分类不存在' }));
  const result = content.queryPosts({
    categoryId: category.id, sort: req.query.sort || 'new',
    page: Number(req.query.page) || 1, perPage: 12,
  });
  const children = store.find('categories', (c) => String(c.parentId) === String(category.id));
  res.render('front/list', baseLocals({
    title: `${category.name} - ${getSettings().siteName}`,
    pageTitle: category.name,
    desc: category.description || getSettings().siteDescription,
    posts: result.list.map(decorate),
    pager: result.pager,
    currentCategory: category,
    currentTag: null,
    children,
    currentType: '',
    currentSort: req.query.sort || 'new',
    keyword: '',
    baseQuery: buildQuery(req.query, { page: null }),
    accessLabel,
    postUrl,
  }));
});

pageRouter.get('/tag/:slug', (req, res) => {
  const tagRow = content.getTagBySlug(req.params.slug);
  if (!tagRow) return res.status(404).render('front/404', baseLocals({ title: '标签不存在', pageTitle: '标签不存在' }));
  const result = content.queryPosts({
    tag: tagRow.name, sort: req.query.sort || 'new',
    page: Number(req.query.page) || 1, perPage: 12,
  });
  res.render('front/list', baseLocals({
    title: `标签：${tagRow.name} - ${getSettings().siteName}`,
    pageTitle: `标签：${tagRow.name}`,
    posts: result.list.map(decorate),
    pager: result.pager,
    currentCategory: null,
    currentTag: tagRow,
    currentType: '',
    currentSort: req.query.sort || 'new',
    keyword: '',
    baseQuery: buildQuery(req.query, { page: null }),
    accessLabel,
    postUrl,
  }));
});

pageRouter.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const result = content.queryPosts({ keyword: q, sort: 'new', page: Number(req.query.page) || 1, perPage: 12 });
  res.render('front/list', baseLocals({
    title: `搜索 ${q} - ${getSettings().siteName}`,
    pageTitle: q ? `“${q}” 的搜索结果` : '搜索资源',
    robots: 'noindex,follow',
    posts: result.list.map(decorate),
    pager: result.pager,
    keyword: q,
    currentCategory: null,
    currentTag: null,
    currentType: '',
    currentSort: 'new',
    baseQuery: `q=${encodeURIComponent(q)}&`,
    accessLabel,
    postUrl,
  }));
});

// 资源详情：解析任意历史形式的链接，并 301 到当前规范地址（利于 SEO 权重集中）
function renderPostPage(req, res, post, currentPath) {
  const cat = store.findById('categories', post.categoryId);

  if (!permalink.isCanonical(post, currentPath, cat)) {
    return res.redirect(301, encodeURI(permalink.postPath(post, cat)));
  }

  content.bumpViews(post.id);
  const fresh = store.findById('posts', post.id);
  const related = content.relatedPosts(fresh, 6).map(decorate);
  const comments = content.listComments(fresh.id);
  const access = userSvc.checkAccess(req.user, fresh);
  const canonicalPath = permalink.postPath(fresh, cat);

  res.render('front/detail', baseLocals({
    title: `${fresh.title} - ${getSettings().siteName}`,
    pageTitle: fresh.title,
    desc: fresh.summary || excerpt(fresh.content, 150),
    keywords: (fresh.tags || []).join(','),
    canonical: absoluteUrl(req, canonicalPath),
    ogImage: fresh.cover || getSettings().ogImage || '',
    ogType: 'article',
    publishedTime: fresh.publishedAt || fresh.createdAt,
    modifiedTime: fresh.updatedAt || fresh.publishedAt || fresh.createdAt,
    post: decorate(fresh),
    raw: fresh,
    contentHtml: md.render(fresh.content),
    category: cat,
    related,
    comments,
    access,
    favorited: req.user ? userSvc.isFavorited(req.user.id, fresh.id) : false,
    accessLabel,
    postUrl,
    formatSize,
    formatDate,
  }));
}

pageRouter.get('/resource/:key', (req, res, next) => {
  const post = permalink.resolveKey(req.params.key);
  if (!post || post.status !== 'published') {
    return res.status(404).render('front/404', baseLocals({ title: '资源不存在或已下架', pageTitle: '资源不存在' }));
  }
  renderPostPage(req, res, post, req.path);
});

// 资源下载中转页
pageRouter.get('/download/:id', (req, res) => {
  const post = content.getPost(req.params.id);
  if (!post || post.status !== 'published') {
    return res.status(404).render('front/404', baseLocals({ title: '资源不存在', pageTitle: '资源不存在' }));
  }
  const access = userSvc.checkAccess(req.user, post);
  if (!access.ok) {
    return res.render('front/download-blocked', baseLocals({
      title: `下载 ${post.title} - ${getSettings().siteName}`,
      pageTitle: '需要更高权限',
      post: decorate(post),
      access,
      raw: post,
      postUrl,
    }));
  }

  // 扣积分 / 记录下载
  if (access.costPoints && req.user) {
    const u = userSvc.findById(req.user.id);
    if (u) { u.points = Math.max(0, (u.points || 0) - access.costPoints); store.save(); }
  }
  content.bumpDownloads(post.id);
  userSvc.recordDownload({ userId: req.user ? req.user.id : null, postId: post.id, ip: userSvc.clientIp(req) });

  const lines = Array.isArray(post.downloadLines) && post.downloadLines.length
    ? post.downloadLines.filter((l) => l && l.url)
    : (post.downloadUrl ? [{ name: '主线路', url: post.downloadUrl, code: post.downloadCode }] : []);

  res.render('front/download', baseLocals({
    title: `下载 ${post.title} - ${getSettings().siteName}`,
    pageTitle: '获取下载地址',
    post: decorate(post),
    raw: post,
    lines,
    postUrl,
  }));
});

// 会员套餐
pageRouter.get('/vip', (req, res) => {
  const plans = userSvc.listPlans(true);
  const orders = req.user ? userSvc.userOrders(req.user.id).slice(0, 10) : [];
  const now = new Date();
  const currentPlan = plans.find((p) => p.recommend) || plans[1] || plans[0] || null;
  res.render('front/vip', baseLocals({
    title: `会员中心 - ${getSettings().siteName}`,
    pageTitle: '开通会员',
    plans, orders, currentPlan, now,
    formatMoney,
    postUrl,
  }));
});

// 积分 / 会员下单
pageRouter.post('/order/create', (req, res) => {
  const settings = getSettings();
  if (settings.shopEnabled === false) {
    return res.status(403).render('front/error', baseLocals({ title: '商城已关闭', pageTitle: '商城已关闭', status: 403, message: '站点暂未开放在线购买，请联系站长。' }));
  }
  if (!req.user) return res.redirect(`/login?redirect=${encodeURIComponent('/vip')}`);
  const plan = store.findById('plans', req.body.planId);
  if (!plan || plan.active === false) {
    return res.status(400).send('套餐不存在或已下架');
  }
  const order = userSvc.createOrder({
    userId: req.user.id, type: 'vip', planId: plan.id,
    amount: plan.price, payMethod: req.body.payMethod || 'manual',
    remark: `${plan.name}（${plan.days >= 36500 ? '永久' : plan.days + ' 天'}）`,
  });
  res.redirect(`/order/${order.orderNo}`);
});

// 订单详情 / 支付
pageRouter.get('/order/:orderNo', (req, res) => {
  const order = store.findOne('orders', (o) => o.orderNo === req.params.orderNo);
  if (!order) return res.status(404).render('front/404', baseLocals({ title: '订单不存在', pageTitle: '订单不存在' }));
  if (!req.user || (String(order.userId) !== String(req.user.id) && req.user.role !== 'admin')) {
    return res.status(403).send('无权查看该订单');
  }
  const plan = order.planId ? store.findById('plans', order.planId) : null;
  const payCfg = pay.getPayConfig();
  res.render('front/order', baseLocals({
    title: `订单 ${order.orderNo} - ${getSettings().siteName}`,
    pageTitle: '订单详情',
    order, plan,
    formatMoney, formatDate,
    payReady: pay.isPayReady(),
    payType: payCfg.payType,
    sandbox: payCfg.sandbox,
  }));
});

// 模拟支付成功（真实环境请替换为支付回调）
pageRouter.post('/order/:orderNo/pay', (req, res) => {
  const order = store.findOne('orders', (o) => o.orderNo === req.params.orderNo);
  if (!order || !req.user || String(order.userId) !== String(req.user.id)) return res.status(403).send('无权操作');
  if (getSettings().payMock !== true) {
    return res.status(403).render('front/error', baseLocals({ title: '支付未开启', pageTitle: '支付未开启', status: 403, message: '在线支付通道尚未配置，请联系站长人工开通。' }));
  }
  userSvc.fulfillOrder(order, 'MOCK' + Date.now());
  res.redirect(`/order/${order.orderNo}`);
});

// 登录 / 注册
pageRouter.get('/login', (req, res) => {
  if (req.user) return res.redirect('/user');
  res.render('front/login', baseLocals({ title: `登录 - ${getSettings().siteName}`, pageTitle: '登录', redirect: req.query.redirect || '/', error: null }));
});

pageRouter.post('/login', (req, res) => {
  const { account, password, redirect } = req.body;
  const r = userSvc.checkLogin(account, password);
  if (r.error) {
    return res.status(400).render('front/login', baseLocals({ title: `登录 - ${getSettings().siteName}`, pageTitle: '登录', redirect: redirect || '/', error: r.error, account }));
  }
  const { token } = userSvc.createSession(r.user.id, req);
  userSvc.loginSuccess(r.user, userSvc.clientIp(req));
  res.cookie('sid', token, { maxAge: 14 * 86400000, httpOnly: true, sameSite: 'Lax', secure: req.protocol === 'https' });
  res.redirect(isSafeRedirect(redirect) ? redirect : '/user');
});

pageRouter.get('/register', (req, res) => {
  if (req.user) return res.redirect('/user');
  const settings = getSettings();
  if (settings.registerEnabled === false) {
    return res.render('front/error', baseLocals({ title: '注册已关闭', pageTitle: '注册已关闭', status: 403, message: '站点当前未开放注册，请联系站长获取账号。' }));
  }
  res.render('front/register', baseLocals({
    title: `注册 - ${settings.siteName}`,
    pageTitle: '注册',
    robots: 'noindex,follow',
    needEmailVerify: settings.registerNeedEmailVerify === true,
    mailReady: mailer.isMailReady(),
    needInvite: settings.registerNeedInvite === true,
    error: null,
    form: {},
  }));
});

pageRouter.post('/register', (req, res) => {
  const settings = getSettings();
  if (settings.registerEnabled === false) return res.status(403).send('注册已关闭');

  const { username, email, password, password2, inviteCode, emailCode } = req.body;
  const form = { username, email, inviteCode };
  const fail = (msg) => res.status(400).render('front/register', baseLocals({
    title: `注册 - ${settings.siteName}`,
    pageTitle: '注册',
    robots: 'noindex,follow',
    needEmailVerify: settings.registerNeedEmailVerify === true,
    mailReady: mailer.isMailReady(),
    needInvite: settings.registerNeedInvite === true,
    error: msg,
    form,
  }));

  if (!username || String(username).trim().length < 3) return fail('用户名至少 3 个字符');
  if (!/^[\w\u4e00-\u9fa5.@-]{3,30}$/.test(String(username))) return fail('用户名只能包含字母、数字、下划线、中文');
  if (!password || String(password).length < 6) return fail('密码至少 6 位');
  if (password !== password2) return fail('两次输入的密码不一致');

  // 邮箱验证码校验（开启后必须通过才能注册）
  if (settings.registerNeedEmailVerify === true) {
    if (!email) return fail('请填写邮箱');
    const v = mailer.verifyCode(email, emailCode);
    if (!v.ok) return fail(v.message);
  }

  const ip = userSvc.clientIp(req);

  // 同 IP 注册频率限制，配合邮箱验证一起挡批量注册
  const limit = Number(settings.registerIpDailyLimit);
  if (Number.isFinite(limit) && limit > 0 && ip) {
    const since = Date.now() - 86400000;
    const used = store.count('users', (u) => u.registerIp === ip && new Date(u.createdAt || 0).getTime() > since);
    if (used >= limit) {
      return fail(`同一网络 24 小时内最多注册 ${limit} 个账号，请稍后再试或联系站长`);
    }
  }

  const r = userSvc.register({ username, email, password, inviteCode, ip });
  if (r.error) return fail(r.error);

  const { token } = userSvc.createSession(r.user.id, req);
  res.cookie('sid', token, { maxAge: 14 * 86400000, httpOnly: true, sameSite: 'Lax' });
  res.redirect('/user');
});

// 发送邮箱验证码（注册用）
apiRouter.post('/register/send-code', async (req, res) => {
  const settings = getSettings();
  if (settings.registerEnabled === false) return res.json({ ok: false, error: '站点未开放注册' });
  if (settings.registerNeedEmailVerify !== true) return res.json({ ok: false, error: '站点未开启邮箱验证，可直接注册' });

  const email = String(req.body.email || '').trim();
  if (!email) return res.json({ ok: false, error: '请先填写邮箱' });

  try {
    const r = await mailer.sendVerifyCode({ email, ip: userSvc.clientIp(req) });
    if (!r.ok) return res.json({ ok: false, error: r.message });
    // 仅在「未配置 SMTP 的调试模式」且管理员显式开启回显时，才把验证码直接返回给前端
    const echo = r.devMode === true && settings.mailEchoCode === true;
    return res.json({
      ok: true,
      message: r.message,
      devMode: r.devMode === true,
      code: echo ? r.code : undefined,
    });
  } catch (err) {
    return res.json({ ok: false, error: `发送失败：${err.message}` });
  }
});

pageRouter.get('/logout', (req, res) => {
  userSvc.destroySession(req.cookies && req.cookies['sid']);
  res.clearCookie('sid');
  res.redirect('/');
});

// 用户中心
pageRouter.get('/user', (req, res, next) => {
  if (!req.user) return res.redirect(`/login?redirect=${encodeURIComponent('/user')}`);
  const tab = req.query.tab || 'profile';
  const data = { tab };
  if (tab === 'orders') data.orders = userSvc.userOrders(req.user.id);
  if (tab === 'favorites') data.favorites = userSvc.userFavorites(req.user.id).map(decorate);
  if (tab === 'downloads') data.downloads = userSvc.userDownloads(req.user.id).map((d) => Object.assign({}, d, { post: decorate(d.post) }));
  data.notices = userSvc.listNotices(req.user.id);
  res.render('front/user', baseLocals(Object.assign({
    title: `用户中心 - ${getSettings().siteName}`,
    pageTitle: '用户中心',
    formatMoney, formatDate, timeAgo, postUrl, decorate,
  }, data)));
});

// 修改密码
pageRouter.post('/user/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { oldPassword, newPassword, newPassword2 } = req.body;
  const { verifyPassword, hashPassword } = require('../utils/password');
  if (!verifyPassword(oldPassword, req.user.password)) return res.redirect('/user?tab=profile&msg=' + encodeURIComponent('原密码不正确'));
  if (!newPassword || newPassword.length < 6) return res.redirect('/user?tab=profile&msg=' + encodeURIComponent('新密码至少 6 位'));
  if (newPassword !== newPassword2) return res.redirect('/user?tab=profile&msg=' + encodeURIComponent('两次输入的新密码不一致'));
  req.user.password = hashPassword(newPassword);
  store.save();
  res.redirect('/user?tab=profile&msg=' + encodeURIComponent('密码修改成功'));
});

// 更新资料
pageRouter.post('/user/profile', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const { nickname, email } = req.body;
  req.user.nickname = String(nickname || req.user.username).slice(0, 30);
  req.user.email = String(email || '').slice(0, 100);
  store.save();
  res.redirect('/user?tab=profile&msg=' + encodeURIComponent('资料已更新'));
});

// 关于 / 免责 / 联系 / 投稿
pageRouter.get('/about', (req, res) => {
  const settings = getSettings();
  res.render('front/page', baseLocals({
    title: `关于我们 - ${settings.siteName}`,
    pageTitle: '关于我们',
    contentHtml: md.render(settings.aboutUs || ''),
    postUrl,
  }));
});

pageRouter.get('/disclaimer', (req, res) => {
  const settings = getSettings();
  res.render('front/page', baseLocals({
    title: `免责声明 - ${settings.siteName}`,
    pageTitle: '免责声明',
    contentHtml: md.render(settings.disclaimer || ''),
    postUrl,
  }));
});

pageRouter.get('/copyright', (req, res) => {
  const settings = getSettings();
  res.render('front/page', baseLocals({
    title: `版权与侵权处理 - ${settings.siteName}`,
    pageTitle: '版权与侵权处理',
    contentHtml: md.render(`## 侵权处理流程

1. 权利人通过页面底部联系方式提交书面通知，包含权属证明、侵权内容 URL、联系方式。
2. 本站核实后将在 **24 小时内** 下架相关内容或断开链接。
3. 如对处理结果有异议，可通过同一渠道提交反通知。

## 我们的态度

本站不存储、不制作任何受版权保护的商业软件破解版本；如发现用户上传的内容存在侵权，我们一律删除并封禁账号。`),
    postUrl,
  }));
});

pageRouter.get('/contact', (req, res) => {
  const settings = getSettings();
  res.render('front/page', baseLocals({
    title: `联系我们 - ${settings.siteName}`,
    pageTitle: '联系我们',
    contentHtml: md.render(`## 联系方式

- 邮箱：${settings.contactEmail || '未设置'}
- 微信：${settings.contactWechat || '未设置'}
- QQ：${settings.contactQQ || '未设置'}

## 商务合作

本站首页、侧边栏、详情页均设有广告位，支持图文广告与广告联盟代码接入。如需投放请联系上方邮箱，注明「广告合作」。

## 资源投稿

欢迎投稿原创安全工具与原创教程，审核通过后将署名发布，并可获得会员时长或积分奖励。`),
    postUrl,
  }));
});

// SEO：sitemap / robots / rss
pageRouter.get('/sitemap.xml', (req, res) => {
  const settings = getSettings();
  const base = (settings.siteUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const posts = content.queryPosts({ perPage: 5000, sort: 'update' }).list;
  const urls = [
    { loc: '/', pri: '1.0' },
    { loc: '/resources', pri: '0.9' },
    { loc: '/vip', pri: '0.8' },
    ...store.all('categories').map((c) => ({ loc: `/category/${c.slug}`, pri: '0.7' })),
    ...posts.map((p) => ({ loc: postUrl(p), pri: '0.6', lastmod: (p.updatedAt || p.publishedAt || p.createdAt || '').slice(0, 10) })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((u) => `  <url><loc>${esc(base + u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}<priority>${u.pri}</priority></url>`).join('\n')
    + `\n</urlset>`;
  res.type('application/xml').send(xml);
});

pageRouter.get('/robots.txt', (req, res) => {
  const settings = getSettings();
  const base = (settings.siteUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /user',
    'Disallow: /download/',
    `Sitemap: ${base}/sitemap.xml`,
  ].join('\n'));
});

pageRouter.get('/rss.xml', (req, res) => {
  const settings = getSettings();
  const base = (settings.siteUrl || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const posts = content.queryPosts({ perPage: 30, sort: 'new' }).list;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>\n`
    + `<title>${esc(settings.siteName)}</title>\n<link>${esc(base)}</link>\n<description>${esc(settings.siteDescription)}</description>\n`
    + posts.map((p) => `  <item><title>${esc(p.title)}</title><link>${esc(base + postUrl(p))}</link><description>${esc(p.summary || '')}</description><pubDate>${new Date(p.publishedAt || p.createdAt).toUTCString()}</pubDate></item>`).join('\n')
    + `\n</channel></rss>`;
  res.type('application/rss+xml').send(xml);
});

// 兜底路由：解析「分类/别名」「类型/别名」「自定义前缀/别名」形式的链接
// 必须放在所有具体路由之后，命中失败则交给 404 处理
pageRouter.get('/:first/:second', (req, res, next) => {
  const RESERVED = new Set([
    'admin', 'api', 'uploads', 'css', 'js', 'favicon.svg', 'healthz',
    'resource', 'category', 'tag', 'user', 'pay', 'order', 'search',
    'login', 'register', 'logout', 'vip', 'about', 'disclaimer',
    'copyright', 'contact', 'download', 'sitemap.xml', 'robots.txt', 'rss.xml',
  ]);
  if (RESERVED.has(req.params.first)) return next();

  const post = permalink.resolveSegments(req.params.first, req.params.second);
  if (!post || post.status !== 'published') return next();

  return renderPostPage(req, res, post, req.path);
});

// ============================================================
// 前台 API（fetch 调用）
// ============================================================
apiRouter.post('/favorite/:id', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, error: '请先登录', needLogin: true });
  const post = content.getPost(req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: '资源不存在' });
  const state = userSvc.toggleFavorite(req.user.id, post.id);
  res.json({ ok: true, favorited: state });
});

apiRouter.post('/comment/:id', (req, res) => {
  if (getSettings().commentsEnabled === false) return res.status(403).json({ ok: false, error: '评论功能已关闭' });
  const post = content.getPost(req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: '资源不存在' });
  const text = String(req.body.content || '').trim();
  if (text.length < 2) return res.status(400).json({ ok: false, error: '评论内容太短' });
  if (text.length > 1000) return res.status(400).json({ ok: false, error: '评论内容过长' });
  const comment = store.insert('comments', {
    postId: post.id,
    userId: req.user ? req.user.id : null,
    author: req.user ? (req.user.nickname || req.user.username) : '游客',
    content: text,
    status: req.user && req.user.role === 'admin' ? 'approved' : 'approved',
    ip: userSvc.clientIp(req),
  });
  res.json({ ok: true, comment: { author: comment.author, content: text, createdAt: comment.createdAt } });
});

apiRouter.get('/notices/unread', (req, res) => {
  if (!req.user) return res.json({ ok: true, count: 0 });
  res.json({ ok: true, count: userSvc.unreadNoticeCount(req.user.id) });
});

apiRouter.post('/notices/read', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false });
  store.find('notices', (n) => String(n.userId) === String(req.user.id)).forEach((n) => { n.read = true; });
  store.save();
  res.json({ ok: true });
});

// ============================================================
function buildQuery(query, override = {}) {
  const q = Object.assign({}, query, override);
  return Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function siteStats() {
  return {
    posts: store.count('posts', (p) => p.status === 'published'),
    users: store.count('users'),
    downloads: store.all('posts').reduce((a, p) => a + (p.downloads || 0), 0),
    views: store.all('posts').reduce((a, p) => a + (p.views || 0), 0),
  };
}

function isSafeRedirect(url) {
  if (!url) return false;
  const s = String(url);
  return s.startsWith('/') && !s.startsWith('//');
}

module.exports = { pageRouter, apiRouter, decorate, postUrl, accessLabel, baseLocals, siteStats };
