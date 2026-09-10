'use strict';

/**
 * 支付路由
 * - notifyRouter：支付宝异步通知，必须挂在 CSRF 中间件之前（第三方服务器不会携带 CSRF token）
 * - payRouter：支付页、二维码获取、状态轮询、主动查单、同步跳转
 */

const express = require('express');
const QRCode = require('qrcode');

const store = require('../db/store');
const pay = require('../services/pay');
const userSvc = require('../services/user');
const { getSettings } = require('../services/settings');
const { esc } = require('../utils/helpers');

const notifyRouter = express.Router();
const payRouter = express.Router();

// 上次向支付宝主动查单的时间（节流，避免轮询把接口打爆）
const lastQuery = new Map();
const QUERY_INTERVAL = 5000;

function logPay(action, data) {
  try {
    store.insert('paylogs', Object.assign({ action }, data));
  } catch (_) { /* 日志失败不影响主流程 */ }
}

// ============================================================
// 异步通知（免 CSRF）
// ============================================================
notifyRouter.post('/api/pay/alipay/notify', (req, res) => {
  const params = req.body || {};
  const orderNo = String(params.out_trade_no || '');

  try {
    if (!pay.verifyNotify(params)) {
      logPay('notify-invalid-sign', { orderNo, tradeStatus: params.trade_status });
      console.warn('[pay] 异步通知验签失败:', orderNo);
      return res.type('text/plain').send('failure');
    }

    const order = store.findOne('orders', (o) => o.orderNo === orderNo);
    if (!order) {
      logPay('notify-order-missing', { orderNo });
      return res.type('text/plain').send('failure');
    }

    const match = pay.checkNotifyMatch(params, order);
    if (!match.ok) {
      logPay('notify-mismatch', { orderNo, reason: match.reason, totalAmount: params.total_amount });
      console.warn('[pay] 异步通知业务校验失败:', orderNo, match.reason);
      return res.type('text/plain').send('failure');
    }

    if (order.status !== 'paid') {
      userSvc.fulfillOrder(order, params.trade_no);
      logPay('notify-paid', { orderNo, tradeNo: params.trade_no, amount: order.amount });
      console.log(`[pay] 支付宝异步通知已确认收款：${orderNo}`);
    }
    // 幂等：重复通知同样返回 success，避免支付宝持续重推
    return res.type('text/plain').send('success');
  } catch (err) {
    console.error('[pay] 处理异步通知异常:', err.message);
    logPay('notify-error', { orderNo, message: err.message });
    return res.type('text/plain').send('failure');
  }
});

// ============================================================
// 支付页面
// ============================================================

function loadOrder(req, res) {
  const order = store.findOne('orders', (o) => o.orderNo === req.params.orderNo);
  if (!order) {
    res.status(404).render('front/404', { title: '订单不存在', pageTitle: '订单不存在', settings: getSettings() });
    return null;
  }
  if (!req.user || (String(order.userId) !== String(req.user.id) && req.user.role !== 'admin')) {
    res.status(403).send('无权访问该订单');
    return null;
  }
  return order;
}

payRouter.get('/pay/:orderNo', (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  const plan = order.planId ? store.findById('plans', order.planId) : null;
  const cfg = pay.getPayConfig();

  if (order.status === 'paid') return res.redirect(`/order/${order.orderNo}`);

  res.render('front/pay', {
    title: `订单支付 - ${getSettings().siteName}`,
    pageTitle: '订单支付',
    settings: getSettings(),
    helpers: require('../utils/helpers'),
    csrf: req.csrfToken,
    user: req.user,
    order, plan,
    payReady: pay.isPayReady(),
    payType: cfg.payType,
    sandbox: cfg.sandbox,
  });
});

/** 电脑网站支付：直接跳转支付宝收银台 */
payRouter.get('/pay/:orderNo/go', (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  if (order.status === 'paid') return res.redirect(`/order/${order.orderNo}`);
  if (!pay.isPayReady()) return res.status(400).send('支付宝支付未配置或未启用');

  try {
    const plan = order.planId ? store.findById('plans', order.planId) : null;
    const url = pay.buildPagePayUrl(order, plan);
    logPay('page-pay-redirect', { orderNo: order.orderNo, amount: order.amount });
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`发起支付失败：${esc(err.message)}`);
  }
});

/** 获取支付二维码（扫码模式） */
payRouter.get('/api/pay/qr/:orderNo', async (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  if (order.status === 'paid') return res.json({ ok: true, paid: true });
  if (!pay.isPayReady()) return res.json({ ok: false, error: '支付宝支付未配置或未启用' });

  try {
    const plan = order.planId ? store.findById('plans', order.planId) : null;
    const { qrCode } = await pay.createQrPay(order, plan);
    const dataUrl = await QRCode.toDataURL(qrCode, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
    logPay('qr-created', { orderNo: order.orderNo, amount: order.amount });
    res.json({ ok: true, qrCode, dataUrl });
  } catch (err) {
    logPay('qr-error', { orderNo: order.orderNo, message: err.message });
    res.json({ ok: false, error: err.message });
  }
});

/** 订单状态查询（前端轮询；必要时自动向支付宝查单） */
payRouter.get('/api/pay/status/:orderNo', async (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;

  if (order.status === 'paid') {
    return res.json({ ok: true, status: 'paid', redirect: `/order/${order.orderNo}` });
  }

  const key = String(order.orderNo);
  const last = lastQuery.get(key) || 0;
  if (pay.isPayReady() && Date.now() - last > QUERY_INTERVAL) {
    lastQuery.set(key, Date.now());
    try {
      const r = await pay.queryTrade(order.orderNo);
      const paidFen = Math.round((Number(r.totalAmount) || 0) * 100);
      if ((r.tradeStatus === 'TRADE_SUCCESS' || r.tradeStatus === 'TRADE_FINISHED') && paidFen === Number(order.amount)) {
        userSvc.fulfillOrder(order, r.tradeNo);
        logPay('query-paid', { orderNo: order.orderNo, tradeNo: r.tradeNo });
        return res.json({ ok: true, status: 'paid', redirect: `/order/${order.orderNo}` });
      }
      if (r.tradeStatus === 'TRADE_CLOSED') {
        return res.json({ ok: true, status: 'closed', message: '交易已关闭，请重新下单' });
      }
    } catch (err) {
      // 查单失败不阻塞轮询，下次继续
      lastQuery.set(key, Date.now() - QUERY_INTERVAL + 8000 > 0 ? Date.now() - QUERY_INTERVAL + 8000 : Date.now());
    } finally {
      if (lastQuery.size > 500) {
        const cutoff = Date.now() - 600000;
        for (const [k, v] of lastQuery) if (v < cutoff) lastQuery.delete(k);
      }
    }
  }

  res.json({ ok: true, status: order.status, redirect: `/order/${order.orderNo}` });
});

/** 用户手动点「我已支付」：立即向支付宝查单 */
payRouter.post('/api/pay/query/:orderNo', async (req, res) => {
  const order = loadOrder(req, res);
  if (!order) return;
  if (order.status === 'paid') return res.json({ ok: true, status: 'paid', redirect: `/order/${order.orderNo}` });
  if (!pay.isPayReady()) return res.json({ ok: false, error: '支付宝支付未配置或未启用' });

  try {
    const r = await pay.queryTrade(order.orderNo);
    if (r.tradeStatus === 'TRADE_SUCCESS' || r.tradeStatus === 'TRADE_FINISHED') {
      const paidFen = Math.round((Number(r.totalAmount) || 0) * 100);
      if (paidFen !== Number(order.amount)) {
        return res.json({ ok: false, error: `支付金额不匹配（应付 ¥${(order.amount / 100).toFixed(2)}，实付 ¥${r.totalAmount}）` });
      }
      userSvc.fulfillOrder(order, r.tradeNo);
      logPay('manual-query-paid', { orderNo: order.orderNo, tradeNo: r.tradeNo });
      return res.json({ ok: true, status: 'paid', redirect: `/order/${order.orderNo}` });
    }
    if (r.tradeStatus === 'WAIT_BUYER_PAY') {
      return res.json({ ok: true, status: 'pending', message: '尚未检测到付款，请完成支付后再点击' });
    }
    if (r.tradeStatus === 'TRADE_CLOSED') {
      return res.json({ ok: true, status: 'closed', message: '交易已关闭，请重新下单' });
    }
    return res.json({ ok: true, status: 'unknown', message: `当前交易状态：${r.tradeStatus || '未知'}` });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

/** 同步跳转（用户支付后从支付宝跳回） */
payRouter.get('/pay/return', (req, res) => {
  const params = req.query || {};
  const orderNo = String(params.out_trade_no || '');
  const order = orderNo ? store.findOne('orders', (o) => o.orderNo === orderNo) : null;

  if (order && order.status !== 'paid' && pay.isPayReady()) {
    // 同步跳转只作展示，最终状态以查单/异步通知为准；这里兜底触发一次查单
    pay.queryTrade(orderNo).then((r) => {
      if ((r.tradeStatus === 'TRADE_SUCCESS' || r.tradeStatus === 'TRADE_FINISHED')
        && Math.round((Number(r.totalAmount) || 0) * 100) === Number(order.amount)) {
        userSvc.fulfillOrder(order, r.tradeNo);
        logPay('return-paid', { orderNo, tradeNo: r.tradeNo });
      }
    }).catch((err) => {
      logPay('return-query-error', { orderNo, message: err.message });
    });
  }

  if (order) return res.redirect(`/order/${order.orderNo}`);
  res.redirect('/user?tab=orders');
});

module.exports = { notifyRouter, payRouter };
