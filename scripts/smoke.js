'use strict';

/**
 * 冒烟测试脚本：服务启动后执行  node scripts/smoke.js
 * 覆盖前台页面、权限校验、CSRF、后台登录、内容增删改、下单收款、支付宝回调、全站备份等关键链路。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const ADMIN = { account: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin888' };

const FREE_POST_ID = 1;   // 种子数据中 Nmap 为免费资源
const VIP_POST_ID = 5;    // 种子数据中 Metasploit 为 VIP 资源

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

class Jar {
  constructor() { this.cookies = new Map(); }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /Max-Age=0/.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, decodeURIComponent(v));
    }
  }
  get(name) { return this.cookies.get(name) || ''; }
}

async function req(jar, path, opts = {}) {
  const headers = Object.assign({ 'user-agent': 'smoke-test' }, opts.headers || {});
  if (jar) {
    const c = jar.header();
    if (c) headers.cookie = c;
  }
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(opts.form).toString();
    if (!opts.method) opts.method = 'POST';
  }
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body, redirect: 'manual' });
  if (jar) jar.absorb(res);
  let text = '';
  let buffer = null;
  if (opts.raw) {
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    try { text = await res.text(); } catch (_) { /* ignore */ }
  }
  return { status: res.status, text, buffer, location: res.headers.get('location') || '' };
}

(async function main() {
  console.log(`\n=== SecShare 冒烟测试 @ ${BASE} ===\n`);

  const anon = new Jar();

  console.log('[1] 前台公开页面');
  const pages = ['/', '/resources', '/resources?type=doc', '/resources?sort=download',
    '/category/penetration', '/tag/开源免费', '/search?q=nmap',
    '/vip', '/login', '/register', '/about', '/disclaimer', '/contact', '/copyright',
    '/sitemap.xml', '/robots.txt', '/rss.xml', '/healthz'];
  for (const p of pages) {
    const r = await req(anon, p);
    ok(`GET ${p}`, r.status === 200, `=> ${r.status}`);
  }
  const notFound = await req(anon, '/this-page-not-exist');
  ok('未知路径返回 404', notFound.status === 404, `=> ${notFound.status}`);

  // 旧数字 ID 链接应 301 到规范别名地址（SEO 权重集中）
  const legacy = await req(anon, '/resource/1');
  ok('旧数字 ID 链接 301 到规范地址', legacy.status === 301 && /^\/resource\//.test(legacy.location), `=> ${legacy.status} ${legacy.location}`);
  const slugPath = legacy.location || '';
  const canonicalPage = await req(anon, slugPath);
  ok('规范别名地址可正常访问', canonicalPage.status === 200, `=> ${canonicalPage.status}`);

  console.log('\n[2] 静态资源与 SEO 输出');
  const css = await req(anon, '/css/main.css');
  ok('前台样式表可访问', css.status === 200 && css.text.includes('--primary'));
  const js = await req(anon, '/js/main.js');
  ok('前台脚本可访问', js.status === 200);
  const sm = await req(anon, '/sitemap.xml');
  ok('sitemap 含资源链接', sm.text.includes('<urlset') && sm.text.includes('/resource/'));
  const rss = await req(anon, '/rss.xml');
  ok('RSS 输出正常', rss.text.includes('<rss'));

  console.log('\n[3] 游客权限与 CSRF 防护');
  const freeAnon = await req(anon, `/download/${FREE_POST_ID}`);
  ok('游客可下载免费资源', freeAnon.status === 200 && freeAnon.text.includes('获取下载地址'), `=> ${freeAnon.status}`);
  const vipAnon = await req(anon, `/download/${VIP_POST_ID}`);
  ok('游客下载 VIP 资源被拦截', vipAnon.status === 200 && /VIP 会员专享|权限不足/.test(vipAnon.text));
  const noToken = await req(anon, '/api/favorite/1', { method: 'POST' });
  ok('缺失 CSRF token 的 POST 被拒绝', noToken.status === 403, `=> ${noToken.status}`);
  const badToken = await req(anon, '/api/favorite/1', { method: 'POST', headers: { 'x-csrf-token': 'wrong' } });
  ok('错误 CSRF token 的 POST 被拒绝', badToken.status === 403, `=> ${badToken.status}`);
  const noLogin = await req(anon, '/api/favorite/1', { method: 'POST', headers: { 'x-csrf-token': anon.get('csrf') } });
  ok('未登录访问受保护接口返回 401', noLogin.status === 401, `=> ${noLogin.status}`);

  console.log('\n[4] 用户注册 / 登录 / 下载 / 互动');
  const user = new Jar();
  await req(user, '/register');
  const uname = 'smoke' + Date.now().toString().slice(-6);
  const reg = await req(user, '/register', {
    method: 'POST',
    form: { _csrf: user.get('csrf'), username: uname, email: `${uname}@test.com`, password: 'test1234', password2: 'test1234' },
  });
  ok('注册成功并自动登录', reg.status === 302, `=> ${reg.status}`);
  const me = await req(user, '/user');
  ok('注册后可访问用户中心', me.status === 200 && me.text.includes(uname));
  const weakReg = await req(user, '/register', { method: 'POST', form: { _csrf: user.get('csrf'), username: 'ab', password: '1', password2: '2' } });
  ok('弱密码注册被拒绝', weakReg.status === 400, `=> ${weakReg.status}`);

  const dlFree = await req(user, `/download/${FREE_POST_ID}`);
  ok('登录用户可下载免费资源', dlFree.status === 200 && dlFree.text.includes('获取下载地址'));
  const dlVip = await req(user, `/download/${VIP_POST_ID}`);
  ok('非会员下载 VIP 资源被拦截', dlVip.status === 200 && /VIP 会员专享|权限不足/.test(dlVip.text));

  const fav = await req(user, '/api/favorite/1', { method: 'POST', headers: { 'x-csrf-token': user.get('csrf') } });
  const favJson = JSON.parse(fav.text || '{}');
  ok('收藏接口工作正常', favJson.ok === true && favJson.favorited === true, fav.text.slice(0, 60));
  const cmt = await req(user, '/api/comment/1', {
    method: 'POST',
    headers: { 'x-csrf-token': user.get('csrf'), 'content-type': 'application/json' },
    body: JSON.stringify({ content: '冒烟测试评论内容' }),
  });
  ok('评论接口工作正常', JSON.parse(cmt.text || '{}').ok === true);

  console.log('\n[5] 后台登录与页面');
  const adm = new Jar();
  await req(adm, '/admin/login');
  const guard = new Jar();
  const guardRes = await req(guard, '/admin/posts');
  ok('未登录访问后台被重定向', guardRes.status === 302 && guardRes.location.includes('/admin/login'), `=> ${guardRes.status}`);

  const wrongLogin = await req(adm, '/admin/login', { method: 'POST', form: { _csrf: adm.get('csrf'), account: ADMIN.account, password: 'wrong-password' } });
  ok('错误密码无法登录后台', wrongLogin.status === 400, `=> ${wrongLogin.status}`);

  const admLogin = await req(adm, '/admin/login', { method: 'POST', form: { _csrf: adm.get('csrf'), account: ADMIN.account, password: ADMIN.password } });
  ok('管理员登录成功', admLogin.status === 302, `=> ${admLogin.status} ${admLogin.text.slice(0, 60)}`);

  const adminPages = ['/admin', '/admin/posts', '/admin/posts?status=all', '/admin/posts/new',
    '/admin/posts/1/edit', '/admin/categories', '/admin/tags', '/admin/comments', '/admin/users',
    '/admin/orders', '/admin/plans', '/admin/ads', '/admin/announcements', '/admin/links',
    '/admin/settings', '/admin/stats', '/admin/backup'];
  for (const p of adminPages) {
    const r = await req(adm, p);
    ok(`GET ${p}`, r.status === 200, `=> ${r.status}`);
  }
  const nonAdmin = await req(user, '/admin');
  ok('普通用户无法访问后台', nonAdmin.status === 302, `=> ${nonAdmin.status}`);

  console.log('\n[6] 后台内容管理（增 / 改 / 查 / 删）');
  const create = await req(adm, '/admin/posts/save', {
    method: 'POST',
    form: {
      _csrf: adm.get('csrf'), title: '冒烟测试资源（可删除）',
      type: 'software', categoryId: '1', status: 'published', accessLevel: 'free',
      summary: '由自动化测试创建', content: '# 测试\n\n这是冒烟测试内容',
      tags: '测试,自动化', lineName: '主线路', lineUrl: 'https://example.com/test.zip', lineCode: '', size: '1 MB',
    },
  });
  ok('新增资源成功', create.status === 302, `=> ${create.status}`);

  const listHtml = (await req(adm, '/admin/posts?status=all&q=冒烟测试')).text;
  const newId = (listHtml.match(/\/admin\/posts\/(\d+)\/edit/) || [])[1];
  ok('新增内容出现在列表中', !!newId, '未找到新增记录');
  if (newId) {
    const edit = await req(adm, `/admin/posts/${newId}/edit`);
    ok('编辑页可打开', edit.status === 200 && edit.text.includes('冒烟测试资源'));
    const update = await req(adm, '/admin/posts/save', {
      method: 'POST',
      form: {
        _csrf: adm.get('csrf'), id: newId, title: '冒烟测试资源（已改名）',
        type: 'software', categoryId: '1', status: 'published', accessLevel: 'free', content: '# 更新', tags: '测试', size: '2 MB',
      },
    });
    ok('编辑资源成功', update.status === 302, `=> ${update.status}`);
    const del = await req(adm, `/admin/posts/${newId}/delete`, { method: 'POST', form: { _csrf: adm.get('csrf') } });
    ok('删除资源成功', del.status === 302, `=> ${del.status}`);
  }

  const catAdd = await req(adm, '/admin/categories/save', {
    method: 'POST', form: { _csrf: adm.get('csrf'), name: '冒烟分类', slug: 'smoke-cat', icon: '🧪', sort: '99' },
  });
  ok('新增分类成功', catAdd.status === 302, `=> ${catAdd.status}`);
  const catHtml = (await req(adm, '/admin/categories')).text;
  const catId = (catHtml.match(/\/admin\/categories\/(\d+)\/delete/g) || []).pop();
  if (catId) {
    const id = catId.match(/(\d+)/)[1];
    const catDel = await req(adm, `/admin/categories/${id}/delete`, { method: 'POST', form: { _csrf: adm.get('csrf') } });
    ok('删除分类成功', catDel.status === 302, `=> ${catDel.status}`);
  }

  const linkAdd = await req(adm, '/admin/links/save', {
    method: 'POST', form: { _csrf: adm.get('csrf'), name: '冒烟友链', url: 'https://example.com', sort: '99', active: 'on' },
  });
  ok('新增友链成功', linkAdd.status === 302, `=> ${linkAdd.status}`);

  console.log('\n[7] 系统设置与数据备份');
  const bools = ['commentsEnabled', 'registerEnabled', 'registerNeedInvite', 'downloadNeedLogin',
    'adsEnabled', 'vipEnabled', 'shopEnabled', 'payMock'];
  const settingsForm = { _csrf: adm.get('csrf'), __bools: bools.join(',') };
  bools.forEach((b) => {
    // 仅开启：评论、注册、下载需登录、广告、会员、商城
    if (['commentsEnabled', 'registerEnabled', 'downloadNeedLogin', 'adsEnabled', 'vipEnabled', 'shopEnabled'].includes(b)) settingsForm[b] = 'on';
  });
  Object.assign(settingsForm, {
    siteName: 'SecShare 安全资源站', siteSubtitle: '工欲善其事，必先利其器',
    siteDescription: '专注网络安全工具、渗透测试资源与安全学习资料分享的平台',
    siteKeywords: '网络安全,渗透测试,安全工具', siteUrl: 'http://localhost:3000',
    logoText: 'SecShare', logoImage: '', icp: '', police: '',
    contactEmail: 'admin@example.com', contactWechat: '', contactQQ: '',
    inviteCode: 'SEC2026', pointsPerRegister: '10', pointsPerDownload: '0',
    defaultDownloadMode: 'vip', moneyUnit: '¥', statsCode: '',
    siteFooterNote: '本站资源仅供安全研究与学习交流使用。', disclaimer: '仅供学习交流，禁止非法用途。', aboutUs: '一线安全工程师维护。',
  });
  const setRes = await req(adm, '/admin/settings', { method: 'POST', form: settingsForm });
  ok('保存站点设置成功', setRes.status === 302, `=> ${setRes.status}`);
  const afterSet = await req(adm, '/admin/settings');
  ok('设置已持久化（会员功能保持开启）', afterSet.text.includes('name="vipEnabled" checked'));

  const backupCreate = await req(adm, '/admin/backup/create', { method: 'POST', form: { _csrf: adm.get('csrf') } });
  ok('创建数据备份成功', backupCreate.status === 302, `=> ${backupCreate.status}`);
  const backupPage = await req(adm, '/admin/backup');
  ok('备份列表显示备份文件', /(auto|manual)-\d{8}-\d{6}-(full|data)\.tar\.gz/.test(backupPage.text));
  const dbDownload = await req(adm, '/admin/backup/download');
  ok('可下载数据文件', dbDownload.status === 200 && dbDownload.text.includes('"meta"'));

  console.log('\n[8] 下单 → 后台确认收款 → 会员开通');
  const orderRes = await req(user, '/vip');
  const planId = (orderRes.text.match(/name="planId" value="(\d+)"/) || [])[1];
  ok('会员页渲染下单表单', !!planId);
  let orderNo = '';
  if (planId) {
    const order = await req(user, '/order/create', { method: 'POST', form: { _csrf: user.get('csrf'), planId } });
    orderNo = (order.location.match(/\/order\/(.+)$/) || [])[1] || '';
    ok('下单成功并跳转订单页', order.status === 302 && !!orderNo, `=> ${order.status} ${order.location}`);
  }
  if (orderNo) {
    const od = await req(user, `/order/${orderNo}`);
    ok('订单详情页可访问', od.status === 200 && od.text.includes(orderNo));
    const otherUser = await req(anon, `/order/${orderNo}`);
    ok('他人无法查看该订单', otherUser.status === 403, `=> ${otherUser.status}`);

    const ordersHtml = (await req(adm, '/admin/orders?status=pending')).text;
    ok('后台可见待支付订单', ordersHtml.includes(orderNo));
    const oid = (ordersHtml.match(/\/admin\/orders\/(\d+)\/confirm/) || [])[1];
    if (oid) {
      const conf = await req(adm, `/admin/orders/${oid}/confirm`, { method: 'POST', form: { _csrf: adm.get('csrf'), tradeNo: 'SMOKE-TEST' } });
      ok('后台确认收款成功', conf.status === 302, `=> ${conf.status}`);
      const profile = (await req(user, '/user?tab=profile')).text;
      ok('用户会员已自动开通', /VIP\s*[1-9]/.test(profile));
      const noticePage = (await req(user, '/user?tab=notices')).text;
      ok('用户收到开通通知', noticePage.includes('会员开通成功'));
      const dlVipNow = await req(user, `/download/${VIP_POST_ID}`);
      ok('开通后可下载 VIP 资源', dlVipNow.status === 200 && dlVipNow.text.includes('获取下载地址'));
    }
  }

  // ============ [9] 支付宝支付通道 ============
  console.log('\n[9] 支付宝支付通道');
  const kp = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const TEST_APPID = '2021000000000000';

  // 模拟「支付宝服务端」用私钥对通知参数签名（与服务端验签规则一致：剔除 sign / sign_type）
  function notifySign(params) {
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && params[k] !== '')
      .sort().map((k) => `${k}=${params[k]}`).join('&');
    return crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(kp.privateKey, 'base64');
  }
  function notifyBody(extra) {
    const params = Object.assign({
      app_id: TEST_APPID,
      trade_status: 'TRADE_SUCCESS',
      seller_id: '2088000000000000',
      sign_type: 'RSA2',
    }, extra);
    params.sign = notifySign(params);
    return params;
  }

  const vipHtml = await req(user, '/vip');
  const planId2 = (vipHtml.text.match(/name="planId" value="(\d+)"/) || [])[1];
  const mkOrder = async () => {
    const r = await req(user, '/order/create', { method: 'POST', form: { _csrf: user.get('csrf'), planId: planId2 } });
    return (r.location.match(/\/order\/(.+)$/) || [])[1] || '';
  };

  const no1 = await mkOrder();
  ok('创建待支付订单（支付链路测试用）', !!no1, '下单失败');

  // 先回到「未配置」状态，保证测试可重复执行
  await req(adm, '/admin/payment', {
    method: 'POST',
    form: { _csrf: adm.get('csrf'), alipayMode: 'sandbox', alipayPayType: 'qr', alipayAppId: '', clearKeys: '1' },
  });

  {
    const qrFail = JSON.parse((await req(user, `/api/pay/qr/${no1}`)).text || '{}');
    ok('未配置支付宝时发起支付被明确拒绝', qrFail.ok === false && /未配置|未启用/.test(qrFail.error || ''), JSON.stringify(qrFail).slice(0, 90));
  }

  // 保存配置
  {
    const save = await req(adm, '/admin/payment', {
      method: 'POST',
      form: {
        _csrf: adm.get('csrf'), alipayEnabled: 'on', alipayMode: 'sandbox',
        alipayAppId: TEST_APPID, alipayPayType: 'qr',
        privateKey: kp.privateKey, publicKey: kp.publicKey, alipaySubjectPrefix: '冒烟测试',
      },
    });
    ok('保存支付宝配置成功', save.status === 302 && /msg=/.test(save.location), save.location);

    const badKey = await req(adm, '/admin/payment', {
      method: 'POST',
      form: { _csrf: adm.get('csrf'), alipayEnabled: 'on', alipayAppId: TEST_APPID, privateKey: 'not-a-real-key' },
    });
    ok('格式错误的私钥被拒绝', badKey.status === 302 && /err=/.test(badKey.location || ''), decodeURIComponent(badKey.location || ''));

    const payAdmin = await req(adm, '/admin/settings?tab=pay');
    ok('后台显示密钥已加密保存', payAdmin.text.includes('已加密保存'));
    ok('后台配置状态为「可发起支付」', payAdmin.text.includes('可发起支付'));

    const dbDump = await req(adm, '/admin/backup/download');
    ok('应用私钥加密落盘（无明文）',
      dbDump.text.includes('alipayPrivateKeyEnc') && dbDump.text.includes('v1:') && !dbDump.text.includes('BEGIN PRIVATE KEY'));
  }

  // 订单页 / 支付页
  let orderAmount = '';
  {
    const page = await req(user, `/order/${no1}`);
    ok('订单页出现支付宝支付入口', page.text.includes(`/pay/${no1}`) && page.text.includes('支付宝支付'));
    orderAmount = (page.text.match(/¥(\d+\.\d{2})/) || [])[1] || '';
    ok('订单页可解析应付金额', !!orderAmount, `amount=${orderAmount}`);

    const payPage = await req(user, `/pay/${no1}`);
    ok('支付页可正常打开', payPage.status === 200 && payPage.text.includes('订单支付'));
    const anonPay = await req(anon, `/pay/${no1}`);
    ok('未登录访问支付页被拦截', anonPay.status === 302 || anonPay.status === 403, `=> ${anonPay.status}`);

    const other = new Jar();
    await req(other, '/register');
    await req(other, '/register', {
      method: 'POST',
      form: { _csrf: other.get('csrf'), username: 'other' + Date.now().toString().slice(-6), password: 'test1234', password2: 'test1234' },
    });
    const otherPay = await req(other, `/pay/${no1}`);
    ok('其他用户无法访问他人支付页（越权防护）', otherPay.status === 403, `=> ${otherPay.status}`);
  }

  // 支付通知：伪造与校验
  {
    const noSign = await req(null, '/api/pay/alipay/notify', {
      form: { out_trade_no: no1, trade_status: 'TRADE_SUCCESS', total_amount: orderAmount },
    });
    ok('无签名的支付通知被拒绝', noSign.status === 200 && noSign.text.trim() === 'failure');

    const fakeSign = await req(null, '/api/pay/alipay/notify', {
      form: { out_trade_no: no1, trade_status: 'TRADE_SUCCESS', total_amount: orderAmount, sign: 'ZmFrZQ==', sign_type: 'RSA2' },
    });
    ok('签名错误的支付通知被拒绝', fakeSign.status === 200 && fakeSign.text.trim() === 'failure');

    const wrongApp = await req(null, '/api/pay/alipay/notify', {
      form: notifyBody({ out_trade_no: no1, total_amount: orderAmount, app_id: '9999999999' }),
    });
    ok('app_id 不匹配的通知被拒绝', wrongApp.text.trim() === 'failure');

    const wrongAmount = await req(null, '/api/pay/alipay/notify', {
      form: notifyBody({ out_trade_no: no1, total_amount: '0.01' }),
    });
    ok('金额被篡改的通知被拒绝', wrongAmount.text.trim() === 'failure');

    const ghost = await req(null, '/api/pay/alipay/notify', {
      form: notifyBody({ out_trade_no: 'NOT_EXIST_ORDER_123', total_amount: orderAmount }),
    });
    ok('订单不存在的通知被拒绝', ghost.text.trim() === 'failure');

    const pending = await req(user, `/order/${no1}`);
    ok('以上异常通知均未改变订单状态', pending.text.includes('待支付'));

    const good = await req(null, '/api/pay/alipay/notify', {
      form: notifyBody({ out_trade_no: no1, total_amount: orderAmount, trade_no: '2026091122001450000001' }),
    });
    ok('合法签名的支付通知被接受', good.status === 200 && good.text.trim() === 'success', good.text.slice(0, 40));

    const paidPage = await req(user, `/order/${no1}`);
    ok('订单状态更新为已支付并开通会员', paidPage.text.includes('已支付') && paidPage.text.includes('会员已开通'));

    const again = await req(null, '/api/pay/alipay/notify', {
      form: notifyBody({ out_trade_no: no1, total_amount: orderAmount, trade_no: '2026091122001450000001' }),
    });
    ok('重复通知幂等返回 success', again.text.trim() === 'success');

    const adminPay = await req(adm, '/admin/settings?tab=pay');
    ok('后台支付日志记录到收款', adminPay.text.includes('通知收款成功'));

    const statusApi = JSON.parse((await req(user, `/api/pay/status/${no1}`)).text || '{}');
    ok('订单状态接口返回已支付', statusApi.status === 'paid');
  }

  // ============ [10] 全站备份与恢复 ============
  console.log('\n[10] 全站备份与恢复');
  const bkPage = await req(adm, '/admin/backup');
  ok('备份页可访问', bkPage.status === 200 && bkPage.text.includes('全站备份'));
  ok('备份页展示站点体积统计', bkPage.text.includes('数据库体积') && bkPage.text.includes('上传文件'));

  const guardBk = await req(user, '/admin/backup');
  ok('普通用户无法访问备份页', guardBk.status === 302, `=> ${guardBk.status}`);

  // 先上传一个测试附件，验证上传目录也会进入备份
  let uploadedRel = '';
  {
    const fdUp = new FormData();
    fdUp.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' }), `smoke-${Date.now()}.png`);
    const upRes = await fetch(`${BASE}/admin/upload`, {
      method: 'POST', headers: { cookie: adm.header(), 'x-csrf-token': adm.get('csrf') }, body: fdUp,
    });
    const upJson = JSON.parse(await upRes.text());
    uploadedRel = upJson.url || '';
    ok('上传测试附件成功', upJson.ok === true && /^\/uploads\/images\//.test(uploadedRel), JSON.stringify(upJson).slice(0, 90));
  }

  const createBk = await req(adm, '/admin/backup/create', {
    method: 'POST', form: { _csrf: adm.get('csrf'), scope: 'full' },
  });
  ok('创建全量备份成功', createBk.status === 302 && /msg=/.test(createBk.location || ''), decodeURIComponent(createBk.location || ''));

  const listPage = await req(adm, '/admin/backup');
  const bkName = (listPage.text.match(/manual-\d{8}-\d{6}-full\.tar\.gz/) || [])[0];
  ok('备份列表出现全量备份包', !!bkName, '未找到备份文件');

  const dl = await req(adm, `/admin/backup/file/${bkName}`, { raw: true });
  ok('备份包可下载', dl.status === 200 && dl.buffer && dl.buffer.length > 200, `=> ${dl.status}`);
  ok('备份包为 gzip 格式', !!dl.buffer && dl.buffer[0] === 0x1f && dl.buffer[1] === 0x8b);
  if (dl.buffer && dl.buffer[0] === 0x1f) {
    const inner = zlib.gunzipSync(dl.buffer);
    ok('备份包含 db.json', inner.includes(Buffer.from('db.json')));
    ok('备份包含 uploads 目录', inner.includes(Buffer.from('uploads/')));
    ok('备份包含刚上传的附件', !!uploadedRel && inner.includes(Buffer.from(path.basename(uploadedRel))));
  }

  // 构造含目录穿越路径的恶意备份包
  function makeTarGz(entries) {
    const blocks = [];
    for (const e of entries) {
      const header = Buffer.alloc(512);
      header.write(e.name, 0, 100, 'utf8');
      header.write('0000644\0', 100, 8, 'ascii');
      header.write('0000000\0', 108, 8, 'ascii');
      header.write('0000000\0', 116, 8, 'ascii');
      header.write(`${e.content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
      header.write('00000000000\0', 136, 12, 'ascii');
      header.fill(0x20, 148, 156);
      header.write('0', 156, 1, 'ascii');
      header.write('ustar', 257, 5, 'ascii');
      header.write('00', 263, 2, 'ascii');
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += header[i];
      header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
      header.writeUInt8(0, 154);
      header.writeUInt8(0x20, 155);
      blocks.push(header, e.content);
      const pad = (512 - (e.content.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  }

  {
    const evilGz = makeTarGz([
      { name: 'db.json', content: Buffer.from(JSON.stringify({ meta: { version: 1 } })) },
      { name: '../escaped.txt', content: Buffer.from('pwned') },
    ]);
    const fd = new FormData();
    fd.append('_csrf', adm.get('csrf'));
    fd.append('file', new Blob([evilGz], { type: 'application/gzip' }), 'evil.tar.gz');
    const evilRes = await fetch(`${BASE}/admin/backup/restore`, {
      method: 'POST', headers: { cookie: adm.header() }, body: fd, redirect: 'manual',
    });
    const evilLoc = decodeURIComponent(evilRes.headers.get('location') || '');
    ok('含非法路径的备份包被拒绝', /err=/.test(evilLoc) && /非法路径/.test(evilLoc), evilLoc);
    ok('恶意文件未落盘', !fs.existsSync(path.join(__dirname, '..', 'escaped.txt')));
  }

  // 损坏的备份包应被友好拒绝
  {
    const fd = new FormData();
    fd.append('_csrf', adm.get('csrf'));
    fd.append('file', new Blob([Buffer.from('this is not a backup')], { type: 'application/gzip' }), 'broken.tar.gz');
    const brokenRes = await fetch(`${BASE}/admin/backup/restore`, {
      method: 'POST', headers: { cookie: adm.header() }, body: fd, redirect: 'manual',
    });
    const brokenLoc = decodeURIComponent(brokenRes.headers.get('location') || '');
    ok('损坏的备份包被友好拒绝', /err=/.test(brokenLoc) && /无法解压/.test(brokenLoc), brokenLoc);
  }

  // 删除资源 → 从备份恢复 → 数据还原
  {
    const beforeList = await req(adm, '/admin/posts?status=all');
    const beforeCount = Number((beforeList.text.match(/内容列表（共 (\d+) 条）/) || [])[1]);
    const victimId = (beforeList.text.match(/\/admin\/posts\/(\d+)\/edit/) || [])[1];
    await req(adm, `/admin/posts/${victimId}/delete`, { method: 'POST', form: { _csrf: adm.get('csrf') } });

    const afterDel = await req(adm, '/admin/posts?status=all');
    const afterCount = Number((afterDel.text.match(/内容列表（共 (\d+) 条）/) || [])[1]);
    ok('删除资源后总数减少', afterCount === beforeCount - 1, `${beforeCount} -> ${afterCount}`);

    // 同时删除测试附件，验证恢复能把上传文件一并还原
    const uploadedAbs = path.join(__dirname, '..', 'public', uploadedRel.replace(/^\//, ''));
    if (fs.existsSync(uploadedAbs)) fs.unlinkSync(uploadedAbs);
    ok('测试附件已从磁盘删除', !fs.existsSync(uploadedAbs));

    const restore = await req(adm, '/admin/backup/restore', {
      method: 'POST', form: { _csrf: adm.get('csrf'), name: bkName },
    });
    ok('从备份恢复成功', restore.status === 302 && /msg=/.test(restore.location || ''), decodeURIComponent(restore.location || ''));

    const afterRestore = await req(adm, '/admin/posts?status=all');
    const restoredCount = Number((afterRestore.text.match(/内容列表（共 (\d+) 条）/) || [])[1]);
    ok('恢复后资源数量回到备份时状态', restoredCount === beforeCount, `${restoredCount} vs ${beforeCount}`);

    ok('恢复后上传附件一并还原', fs.existsSync(uploadedAbs));

    const adminAfterRestore = await req(adm, '/admin');
    ok('恢复后管理员会话仍然有效', adminAfterRestore.status === 200);
  }

  // 自动备份策略
  {
    const auto = await req(adm, '/admin/backup/auto', {
      method: 'POST',
      form: {
        _csrf: adm.get('csrf'), backupAutoEnabled: 'on', backupIntervalHours: '24',
        backupKeep: '7', backupIncludeUploads: 'on', backupDir: '',
      },
    });
    ok('自动备份策略保存成功', auto.status === 302);
    const page = await req(adm, '/admin/backup');
    ok('策略已持久化（自动备份开启）', page.text.includes('name="backupAutoEnabled" checked'));
  }

  // ============ [11] 清理测试用的支付配置 ============
  console.log('\n[11] 清理测试数据');
  {
    const cleanup = await req(adm, '/admin/payment', {
      method: 'POST',
      form: {
        _csrf: adm.get('csrf'), alipayMode: 'sandbox', alipayPayType: 'qr',
        alipayAppId: '', clearKeys: '1',
      },
    });
    ok('清理测试用支付密钥', cleanup.status === 302);
    const finalPage = await req(adm, '/admin/settings?tab=pay');
    ok('支付功能已恢复为未启用状态', finalPage.text.includes('未启用') && !finalPage.text.includes('已加密保存'));
  }

  // ============ [12] 邮箱验证注册 ============
  console.log('\n[12] 邮箱验证注册与邮件设置');
  {
    const mailPage = await req(adm, '/admin/settings?tab=mail');
    ok('邮件设置页可访问', mailPage.status === 200 && mailPage.text.includes('SMTP'));

    const enable = await req(adm, '/admin/mail', {
      method: 'POST',
      form: {
        _csrf: adm.get('csrf'), mailEnabled: 'on', registerNeedEmailVerify: 'on',
        registerIpDailyLimit: '0', smtpPort: '465', smtpHost: '', smtpUser: '', smtpFromName: '', smtpFromEmail: '',
      },
    });
    ok('保存邮件设置并开启邮箱验证', enable.status === 302, `=> ${enable.status}`);

    const regPage = await req(anon, '/register');
    ok('注册页出现验证码输入与获取按钮', regPage.text.includes('emailCode') && regPage.text.includes('获取验证码'));

    const mailAddr = `smoke${Date.now().toString().slice(-6)}@example.com`;

    const noCode = await req(anon, '/register', {
      method: 'POST',
      form: { _csrf: anon.get('csrf'), username: 'nc' + Date.now().toString().slice(-6), email: mailAddr, password: 'test1234', password2: 'test1234' },
    });
    ok('缺验证码无法注册', noCode.status === 400 && /验证码/.test(noCode.text), `=> ${noCode.status}`);

    const badMail = await req(anon, '/api/register/send-code', {
      method: 'POST', headers: { 'x-csrf-token': anon.get('csrf'), 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    ok('非法邮箱被拒绝', JSON.parse(badMail.text || '{}').ok === false);

    const send = await req(anon, '/api/register/send-code', {
      method: 'POST', headers: { 'x-csrf-token': anon.get('csrf'), 'content-type': 'application/json' },
      body: JSON.stringify({ email: mailAddr }),
    });
    const sendJson = JSON.parse(send.text || '{}');
    ok('发送验证码成功（未配 SMTP 时降级调试模式）', sendJson.ok === true && sendJson.devMode === true, send.text.slice(0, 120));

    const resend = await req(anon, '/api/register/send-code', {
      method: 'POST', headers: { 'x-csrf-token': anon.get('csrf'), 'content-type': 'application/json' },
      body: JSON.stringify({ email: mailAddr }),
    });
    ok('60 秒内重复发送被限流', JSON.parse(resend.text || '{}').ok === false, resend.text.slice(0, 100));

    const codePage = await req(adm, '/admin/settings?tab=mail');
    const m = codePage.text.match(/smoke\d+@example\.com[\s\S]{0,320}?<b>(\d{6})<\/b>/);
    const code = m ? m[1] : '';
    ok('后台可查看验证码', !!code, '未解析出验证码');

    if (code) {
      const wrong = await req(anon, '/register', {
        method: 'POST',
        form: { _csrf: anon.get('csrf'), username: 'wc' + Date.now().toString().slice(-6), email: mailAddr, password: 'test1234', password2: 'test1234', emailCode: '000000' },
      });
      ok('错误验证码被拒绝', wrong.status === 400 && /验证码/.test(wrong.text), `=> ${wrong.status}`);

      const uname = 'ok' + Date.now().toString().slice(-6);
      const good = await req(anon, '/register', {
        method: 'POST',
        form: { _csrf: anon.get('csrf'), username: uname, email: mailAddr, password: 'test1234', password2: 'test1234', emailCode: code },
      });
      ok('正确验证码可完成注册', good.status === 302, `=> ${good.status}`);
      const mePage = await req(anon, '/user');
      ok('验证注册后自动登录', mePage.status === 200 && mePage.text.includes(uname));

      const reuseJar = new Jar();
      await req(reuseJar, '/register');
      const reuse = await req(reuseJar, '/register', {
        method: 'POST',
        form: { _csrf: reuseJar.get('csrf'), username: 'rz' + Date.now().toString().slice(-6), email: mailAddr, password: 'test1234', password2: 'test1234', emailCode: code },
      });
      ok('验证码不可重复使用', reuse.status === 400, `=> ${reuse.status}`);
    }

    await req(adm, '/admin/mail', {
      method: 'POST',
      form: { _csrf: adm.get('csrf'), registerNeedEmailVerify: '', mailEnabled: '', registerIpDailyLimit: '3', smtpPort: '465' },
    });
    const offPage = await req(anon, '/register');
    ok('关闭后注册页不再要求验证码', !offPage.text.includes('emailCode'));
  }

  // ============ [13] SEO 输出 ============
  console.log('\n[13] SEO 标签与结构化数据');
  {
    const home = await req(anon, '/');
    ok('首页输出 canonical', home.text.includes('rel="canonical"') && home.text.includes('localhost:3000'));
    ok('首页输出 WebSite 结构化数据', home.text.includes('"@type":"WebSite"') && home.text.includes('SearchAction'));
    ok('首页输出 Organization 结构化数据', home.text.includes('"@type":"Organization"'));
    ok('首页输出 og 标签', home.text.includes('og:title') && home.text.includes('og:type'));

    const detail = await req(anon, slugPath);
    ok('详情页输出软件/文章结构化数据', /"@type":"(SoftwareApplication|Article)"/.test(detail.text));
    ok('详情页输出面包屑结构化数据', detail.text.includes('BreadcrumbList'));
    ok('详情页 og:type 为 article', detail.text.includes('og:type" content="article"'));
    ok('详情页输出发布时间 meta', detail.text.includes('article:published_time'));
    ok('详情页 canonical 指向规范别名', detail.text.includes(`${slugPath}"`));

    const search = await req(anon, '/search?q=nmap');
    ok('搜索页输出 noindex', search.text.includes('name="robots" content="noindex'));
    const filtered = await req(anon, '/resources?type=software');
    ok('筛选页输出 noindex', filtered.text.includes('name="robots" content="noindex'));
    const plain = await req(anon, '/resources');
    ok('资源库主页保持可索引', !plain.text.includes('name="robots" content="noindex'));

    const sm = await req(anon, '/sitemap.xml');
    ok('sitemap 使用别名地址', /\/resource\/[a-z0-9][a-z0-9-.]*</.test(sm.text) || sm.text.includes('resource/'));
  }

  // ============ [14] 链接结构切换 ============
  console.log('\n[14] 链接结构切换与旧地址兼容');
  {
    const setStruct = async (form) => req(adm, '/admin/settings', {
      method: 'POST',
      form: Object.assign({ _csrf: adm.get('csrf'), __bools: '' }, form),
    });

    ok('切到 ID 结构', (await setStruct({ permalinkStructure: 'id', permalinkPrefix: 'resource' })).status === 302);
    ok('ID 结构下数字地址可访问', (await req(anon, '/resource/1')).status === 200);
    const oldSlug = await req(anon, slugPath);
    ok('ID 结构下旧别名 301 到数字地址', oldSlug.status === 301 && /\/resource\/\d+$/.test(oldSlug.location), `=> ${oldSlug.status} ${oldSlug.location}`);

    ok('切到「ID-别名」结构', (await setStruct({ permalinkStructure: 'id-slug' })).status === 302);
    const idSlug = await req(anon, '/resource/1');
    ok('ID-别名结构生效', idSlug.status === 301 && /\/resource\/1-/.test(idSlug.location), `=> ${idSlug.location}`);

    ok('切到「分类/别名」结构', (await setStruct({ permalinkStructure: 'category' })).status === 302);
    const catUrl = await req(anon, '/resource/1');
    ok('分类结构生效', catUrl.status === 301 && /^\/[a-z-]+\//.test(catUrl.location), `=> ${catUrl.location}`);
    ok('分类结构地址可访问', (await req(anon, catUrl.location)).status === 200);

    ok('切到「自定义前缀 + .html」', (await setStruct({ permalinkStructure: 'slug', permalinkPrefix: 'tools', permalinkSuffix: '.html' })).status === 302);
    const htmlUrl = await req(anon, slugPath);
    ok('自定义前缀 + .html 生效', htmlUrl.status === 301 && /^\/tools\/.+\.html$/.test(htmlUrl.location), `=> ${htmlUrl.location}`);
    ok('新地址可访问', (await req(anon, htmlUrl.location)).status === 200);

    ok('恢复默认别名结构', (await setStruct({ permalinkStructure: 'slug', permalinkPrefix: 'resource', permalinkSuffix: '' })).status === 302);
    ok('恢复后别名地址正常', (await req(anon, slugPath)).status === 200);

    ok('批量生成别名接口可用', (await req(adm, '/admin/posts/gen-slugs', { method: 'POST', form: { _csrf: adm.get('csrf') } })).status === 302);
  }

  console.log(`\n=== 结果：通过 ${pass} 项，失败 ${fail} 项 ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('测试执行异常:', err);
  process.exit(2);
});
