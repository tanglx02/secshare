'use strict';

/**
 * 网络安全软件与资料分享平台 —— 应用入口
 * 启动：npm start     开发热重载：npm run dev
 */

const express = require('express');
const path = require('path');

const config = require('./src/config');
const store = require('./src/db/store');
const { seed } = require('./src/db/seed');
const { getSettings } = require('./src/services/settings');
const mw = require('./src/middleware');
const frontRoutes = require('./src/routes/front');
const { pageRouter, apiRouter } = frontRoutes;
const adminRouter = require('./src/routes/admin');
const payRoutes = require('./src/routes/pay');
const backup = require('./src/services/backup');

// ---------- 初始化数据 ----------
store.load();
store.installExitHooks();
const seeded = seed();
userCleanup();

// 链接结构依赖 slug：启动时兜底补齐历史数据的别名
try {
  const permalink = require('./src/services/permalink');
  const filled = permalink.generateAllSlugs();
  if (filled) console.log(`[slug] 已为 ${filled} 条内容生成链接别名`);
} catch (err) {
  console.error('[slug] 生成别名失败:', err.message);
}

function userCleanup() {
  const userSvc = require('./src/services/user');
  try { userSvc.cleanupSessions(); } catch (_) { /* ignore */ }
  setInterval(() => { try { userSvc.cleanupSessions(); } catch (_) { /* ignore */ } }, 3600000).unref();
}

// ---------- 应用 ----------
const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

// 模板公共工具（所有视图可直接调用）
app.locals.decorate = frontRoutes.decorate;
app.locals.postUrl = frontRoutes.postUrl;
app.locals.accessLabel = frontRoutes.accessLabel;

app.use(mw.securityHeaders);
app.use(mw.cookieParser);
app.use(express.urlencoded({ extended: false, limit: '4mb' }));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true }));

// 支付宝异步通知必须免 CSRF（挂在 csrf 之前），靠 RSA2 验签保证真实性
app.use(payRoutes.notifyRouter);

app.use(mw.csrf);
app.use(mw.attachGlobals);
app.use(mw.trackVisit);

// 简易请求日志（跳过静态资源）
app.use((req, res, next) => {
  if (!/^\/(css|js|uploads|favicon)/.test(req.path)) {
    const t = Date.now();
    res.on('finish', () => {
      if (process.env.QUIET !== '1') {
        console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${res.statusCode} ${req.originalUrl} ${Date.now() - t}ms`);
      }
    });
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/', payRoutes.payRouter);
app.use('/api', apiRouter);
app.use('/admin', adminRouter);
app.use('/', pageRouter);

app.use(mw.notFound);
app.use(mw.errorHandler);

// ---------- 启动 ----------
const server = app.listen(config.port, config.host, () => {
  const settings = getSettings();
  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log(`  ${settings.siteName} 已启动`);
  console.log(line);
  console.log(`  前台首页   http://localhost:${config.port}/`);
  console.log(`  后台管理   http://localhost:${config.port}/admin`);
  console.log(`  数据文件   ${config.paths.dbFile}`);
  if (seeded) {
    console.log(`\n  已写入初始数据`);
    console.log(`  管理员账号 ${config.admin.username} / ${config.admin.password}  ← 请登录后立即修改`);
    console.log(`  演示用户   demo / demo1234（年费会员）、freeuser / free1234（普通用户）`);
  }

  // 全站自动备份
  try {
    backup.startAutoBackup();
    const list = backup.listBackups();
    const last = list[0];
    console.log(`\n  自动备份   ${settings.backupAutoEnabled === false ? '已关闭' : `每 ${settings.backupIntervalHours} 小时，保留 ${settings.backupKeep} 份`}`);
    console.log(`  备份目录   ${backup.backupDir()}`);
    console.log(`  最近备份   ${last ? `${last.name}（${(last.size / 1024).toFixed(1)} KB）` : '暂无，可到后台「全站备份」立即创建'}`);
  } catch (err) {
    console.error('  自动备份初始化失败:', err.message);
  }

  console.log(`\n  按 Ctrl+C 停止服务\n${line}\n`);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

module.exports = app;
module.exports.server = server;
