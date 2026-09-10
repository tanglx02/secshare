'use strict';

/**
 * 支付宝支付服务
 * - 纯 Node crypto 实现 RSA2(SHA256withRSA) 签名与验签，无需第三方 SDK
 * - 支持「当面付/扫码支付」（alipay.trade.precreate）与「电脑网站支付」（alipay.trade.page.pay）
 * - 应用私钥 / 支付宝公钥采用 AES-256-GCM 加密后落盘，派生自 SESSION_SECRET
 */

const crypto = require('crypto');

const store = require('../db/store');
const config = require('../config');
const { getSettings } = require('./settings');

const GATEWAYS = {
  production: 'https://openapi.alipay.com/gateway.do',
  sandbox: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
};

const KEY_ENC_ALGO = 'aes-256-gcm';

// ============================================================
// 密钥加解密
// ============================================================

function keyMaterial() {
  return crypto.scryptSync(String(config.sessionSecret), 'secshare-alipay-v1', 32);
}

function encryptSecret(plain) {
  const text = String(plain || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(KEY_ENC_ALGO, keyMaterial(), iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

function decryptSecret(payload) {
  const raw = String(payload || '');
  if (!raw) return '';
  if (!raw.startsWith('v1:')) return raw; // 兼容历史明文
  const parts = raw.split(':');
  if (parts.length !== 4) return '';
  try {
    const decipher = crypto.createDecipheriv(KEY_ENC_ALGO, keyMaterial(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch (_) {
    return ''; // SESSION_SECRET 变更后无法解密，需重新填写
  }
}

// ============================================================
// 密钥格式规范化
// ============================================================

function wrapPem(body, label) {
  const lines = String(body).replace(/\s+/g, '').match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

/** 返回可用的私钥 PEM；支持 PKCS8 / PKCS1，也支持只粘贴 base64 */
function normalizePrivateKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const candidates = [];
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(s)) {
    candidates.push(s);
  } else {
    const body = s.replace(/\s+/g, '');
    candidates.push(wrapPem(body, 'PRIVATE KEY'));
    candidates.push(wrapPem(body, 'RSA PRIVATE KEY'));
  }
  for (const candidate of candidates) {
    try {
      crypto.createPrivateKey(candidate);
      return candidate;
    } catch (_) { /* 继续尝试下一种格式 */ }
  }
  return '';
}

/** 返回可用的公钥 PEM */
function normalizePublicKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/BEGIN PUBLIC KEY/.test(s)) {
    try { crypto.createPublicKey(s); return s; } catch (_) { return ''; }
  }
  const body = s.replace(/\s+/g, '');
  const candidate = wrapPem(body, 'PUBLIC KEY');
  try { crypto.createPublicKey(candidate); return candidate; } catch (_) { return ''; }
}

// ============================================================
// 签名 / 验签
// ============================================================

function buildSignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

function signParams(params, privateKeyPem) {
  const pem = normalizePrivateKey(privateKeyPem);
  if (!pem) throw new Error('应用私钥格式不正确，请检查是否完整复制');
  return crypto.createSign('RSA-SHA256').update(buildSignContent(params), 'utf8').sign(pem, 'base64');
}

function verifyParams(params, publicKeyPem) {
  const sign = params.sign;
  if (!sign) return false;
  const pem = normalizePublicKey(publicKeyPem);
  if (!pem) return false;
  const clone = Object.assign({}, params);
  delete clone.sign;
  delete clone.sign_type;
  try {
    return crypto.createVerify('RSA-SHA256')
      .update(buildSignContent(clone), 'utf8')
      .verify(pem, sign, 'base64');
  } catch (_) {
    return false;
  }
}

/** 北京时间 yyyy-MM-dd HH:mm:ss（支付宝要求 GMT+8） */
function beijingTimestamp(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

// ============================================================
// 配置读写
// ============================================================

function getPayConfig() {
  const s = getSettings();
  const encPrivate = store.getSetting('alipayPrivateKeyEnc', '');
  const encPublic = store.getSetting('alipayPublicKeyEnc', '');
  const mode = s.alipayMode === 'production' ? 'production' : 'sandbox';
  return {
    enabled: s.alipayEnabled === true,
    mode,
    sandbox: mode === 'sandbox',
    appId: String(s.alipayAppId || '').trim(),
    payType: s.alipayPayType === 'page' ? 'page' : 'qr',
    gateway: String(s.alipayGateway || '').trim() || GATEWAYS[mode],
    notifyUrl: String(s.alipayNotifyUrl || '').trim(),
    returnUrl: String(s.alipayReturnUrl || '').trim(),
    sellerId: String(s.alipaySellerId || '').trim(),
    subjectPrefix: String(s.alipaySubjectPrefix || '').trim(),
    privateKey: decryptSecret(encPrivate),
    publicKey: decryptSecret(encPublic),
    hasPrivateKey: !!encPrivate,
    hasPublicKey: !!encPublic,
    keyBroken: (!!encPrivate && !decryptSecret(encPrivate)) || (!!encPublic && !decryptSecret(encPublic)),
  };
}

function savePayConfig(input) {
  store.setSettings({
    alipayEnabled: !!input.alipayEnabled,
    alipayMode: input.alipayMode === 'production' ? 'production' : 'sandbox',
    alipayAppId: String(input.alipayAppId || '').trim(),
    alipayPayType: input.alipayPayType === 'page' ? 'page' : 'qr',
    alipayGateway: String(input.alipayGateway || '').trim(),
    alipayNotifyUrl: String(input.alipayNotifyUrl || '').trim(),
    alipayReturnUrl: String(input.alipayReturnUrl || '').trim(),
    alipaySellerId: String(input.alipaySellerId || '').trim(),
    alipaySubjectPrefix: String(input.alipaySubjectPrefix || '').trim(),
  });

  if (input.clearKeys === '1') {
    store.setSetting('alipayPrivateKeyEnc', '');
    store.setSetting('alipayPublicKeyEnc', '');
    return;
  }
  // 留空表示不修改；填写则校验格式后加密保存
  const rawPrivate = String(input.privateKey || '').trim();
  if (rawPrivate) {
    if (!normalizePrivateKey(rawPrivate)) throw new Error('应用私钥格式不正确，请完整复制（PKCS8 或 PKCS1 均可）');
    store.setSetting('alipayPrivateKeyEnc', encryptSecret(rawPrivate));
  }
  const rawPublic = String(input.publicKey || '').trim();
  if (rawPublic) {
    if (!normalizePublicKey(rawPublic)) throw new Error('支付宝公钥格式不正确，请确认复制的是「支付宝公钥」而不是应用公钥');
    store.setSetting('alipayPublicKeyEnc', encryptSecret(rawPublic));
  }
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '********';
  return `${s.slice(0, 4)}********${s.slice(-4)}`;
}

/** 配置是否可发起支付 */
function isPayReady() {
  const c = getPayConfig();
  return c.enabled && !!c.appId && !!c.privateKey;
}

// ============================================================
// 网关调用
// ============================================================

function buildCommonParams(method, cfg, bizContent) {
  const params = {
    app_id: cfg.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: beijingTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  if (cfg.notifyUrl) params.notify_url = cfg.notifyUrl;
  return params;
}

function subMsg(node) {
  if (!node) return '网关无响应';
  const detail = [node.sub_code, node.sub_msg].filter(Boolean).join(' ');
  return detail || node.msg || `支付宝返回错误码 ${node.code}`;
}

async function gatewayRequest(method, bizContent, extra = {}) {
  const cfg = getPayConfig();
  if (!cfg.appId) throw new Error('未配置支付宝 APPID');
  if (!cfg.privateKey) throw new Error('未配置应用私钥，或密钥已失效（请重新保存）');

  const params = buildCommonParams(method, cfg, bizContent);
  Object.assign(params, extra);
  params.sign = signParams(params, cfg.privateKey);

  let res;
  try {
    res = await fetch(cfg.gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`无法连接支付宝网关：${err.message}`);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw new Error('支付宝网关返回内容无法解析，请检查网关地址是否正确');
  }

  const errNode = json.error_response;
  if (errNode) {
    const code = errNode.sub_code || errNode.code || '';
    if (/invalid-signature|invalid_signature/i.test(String(code))) {
      throw new Error('签名校验失败：请检查「应用私钥」是否与 APPID 匹配');
    }
    if (/invalid-app-id|invalid_app_id/i.test(String(code))) {
      throw new Error('APPID 无效：请检查 APPID 与当前环境（沙箱/生产）是否对应');
    }
    if (/invalid-sign-type|not-support-sign-type/i.test(String(code))) {
      throw new Error('签名方式不支持：请确认使用 RSA2');
    }
    throw new Error(`${code} ${errNode.sub_msg || errNode.msg || ''}`.trim());
  }

  const node = json[`${method.replace(/\./g, '_')}_response`];
  if (!node) throw new Error('支付宝网关返回结构异常');
  return node;
}

// ============================================================
// 业务：下单 / 查单 / 验签
// ============================================================

function yuan(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

function orderSubject(order, cfg, plan) {
  const prefix = cfg.subjectPrefix ? `${cfg.subjectPrefix} ` : '';
  const body = plan ? `${plan.name}（${plan.days >= 36500 ? '永久' : plan.days + '天'}）` : `订单 ${order.orderNo}`;
  return `${prefix}${body}`.slice(0, 120);
}

/** 扫码支付：返回二维码内容字符串 */
async function createQrPay(order, plan) {
  const cfg = getPayConfig();
  const node = await gatewayRequest('alipay.trade.precreate', {
    out_trade_no: order.orderNo,
    total_amount: yuan(order.amount),
    subject: orderSubject(order, cfg, plan),
    timeout_express: '30m',
  });
  if (node.code !== '10000') throw new Error(subMsg(node));
  return { qrCode: node.qr_code, outTradeNo: node.out_trade_no };
}

/** 电脑网站支付：返回可直接跳转的收银台地址 */
function buildPagePayUrl(order, plan) {
  const cfg = getPayConfig();
  const params = buildCommonParams('alipay.trade.page.pay', cfg, {
    out_trade_no: order.orderNo,
    total_amount: yuan(order.amount),
    subject: orderSubject(order, cfg, plan),
    product_code: 'FAST_INSTANT_TRADE_PAY',
    timeout_express: '30m',
  });
  if (cfg.returnUrl) params.return_url = cfg.returnUrl;
  params.sign = signParams(params, cfg.privateKey);

  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return `${cfg.gateway}?${query}`;
}

/** 查询交易状态 */
async function queryTrade(orderNo) {
  const node = await gatewayRequest('alipay.trade.query', { out_trade_no: orderNo });
  return {
    code: node.code,
    tradeStatus: node.trade_status || '',
    tradeNo: node.trade_no || '',
    totalAmount: node.total_amount || '',
    buyerPayAmount: node.buyer_pay_amount || '',
    sellerId: node.seller_id || '',
    raw: node,
  };
}

/** 校验支付宝异步通知签名 */
function verifyNotify(params) {
  const cfg = getPayConfig();
  if (!cfg.publicKey) return false;
  return verifyParams(params, cfg.publicKey);
}

/**
 * 校验通知中的业务字段是否与本地订单一致（防篡改 / 防伪造）
 * @returns {{ ok:boolean, reason?:string }}
 */
function checkNotifyMatch(params, order) {
  const cfg = getPayConfig();
  if (params.app_id && cfg.appId && String(params.app_id) !== cfg.appId) {
    return { ok: false, reason: 'app_id 不匹配' };
  }
  if (cfg.sellerId && params.seller_id && String(params.seller_id) !== cfg.sellerId) {
    return { ok: false, reason: 'seller_id 不匹配' };
  }
  if (String(params.out_trade_no) !== String(order.orderNo)) {
    return { ok: false, reason: '订单号不匹配' };
  }
  const paidFen = Math.round((Number(params.total_amount) || 0) * 100);
  if (paidFen !== Number(order.amount || 0)) {
    return { ok: false, reason: `金额不一致（应付 ${yuan(order.amount)}，实付 ${params.total_amount}）` };
  }
  if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(params.trade_status))) {
    return { ok: false, reason: `交易状态不是成功：${params.trade_status}` };
  }
  return { ok: true };
}

/** 连通性自检：调用查单接口验证密钥与网络 */
async function testConnection() {
  try {
    const node = await gatewayRequest('alipay.trade.query', { out_trade_no: `CONNTEST${Date.now()}` });
    if (node.code === '10000') return { ok: true, message: '连接正常' };
    if (node.sub_code === 'ACQ.TRADE_NOT_EXIST' || node.code === '40004') {
      return { ok: true, message: '签名校验通过，网关连通正常（测试订单不存在属预期结果）' };
    }
    return { ok: false, message: subMsg(node) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

/** 默认通知/跳转地址建议值 */
function suggestedUrls(siteUrl) {
  const base = String(siteUrl || '').replace(/\/$/, '');
  return {
    notify: base ? `${base}/api/pay/alipay/notify` : '/api/pay/alipay/notify',
    return: base ? `${base}/pay/return` : '/pay/return',
  };
}

module.exports = {
  GATEWAYS,
  getPayConfig, savePayConfig, isPayReady, suggestedUrls, maskSecret,
  normalizePrivateKey, normalizePublicKey,
  signParams, verifyParams, buildSignContent,
  createQrPay, buildPagePayUrl, queryTrade, verifyNotify, checkNotifyMatch, testConnection,
  encryptSecret, decryptSecret,
};
