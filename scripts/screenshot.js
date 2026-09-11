'use strict';

/**
 * 文档截图脚本：驱动本机 Chrome 生成 README 用图
 * 用法：npm start 之后执行 node scripts/screenshot.js
 * 输出：docs/screenshots/*.png
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const ADMIN = { account: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin888' };
const DEMO = { account: process.env.DEMO_USER || 'demo', password: process.env.DEMO_PASS || 'demo1234' };

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const executablePath = findBrowser();
  if (!executablePath) {
    console.error('未找到 Chrome / Edge，请手动指定浏览器路径');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`\n=== 生成文档截图 @ ${BASE} ===`);
  console.log(`浏览器：${executablePath}\n`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-device-scale-factor=1'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();
  let count = 0;

  async function shot(file, url, opts = {}) {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(opts.wait || 1000);
    if (opts.before) await opts.before(page);
    const target = path.join(OUT, file);
    await page.screenshot({ path: target, fullPage: !!opts.full, type: 'png' });
    const size = fs.statSync(target).size;
    count++;
    console.log(`  ✓ ${file}  (${(size / 1024).toFixed(0)} KB)`);
  }

  async function login(url, account, password) {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
    await page.type('input[name="account"]', account);
    await page.type('input[name="password"]', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      page.click('button[type="submit"]'),
    ]);
  }

  try {
    // ---------- 前台（未登录） ----------
    await shot('01-home.png', '/');
    await shot('02-resources.png', '/resources');
    await shot('03-detail.png', '/resource/1');
    await shot('04-vip.png', '/vip');

    // ---------- 前台（登录后：用户中心） ----------
    await login('/login', DEMO.account, DEMO.password);
    await shot('05-user-center.png', '/user?tab=profile');
    await shot('06-user-orders.png', '/user?tab=orders', { wait: 800 });

    // ---------- 后台 ----------
    await login('/admin/login', ADMIN.account, ADMIN.password);
    await shot('07-admin-dashboard.png', '/admin');
    await shot('08-admin-posts.png', '/admin/posts');
    await shot('09-admin-payment.png', '/admin/settings?tab=pay');
    await shot('10-admin-backup.png', '/admin/backup');
    await shot('11-admin-post-edit.png', '/admin/posts/1/edit');
    await shot('12-admin-users.png', '/admin/users');
    await shot('13-admin-mail.png', '/admin/settings?tab=mail');
    await shot('14-admin-settings.png', '/admin/settings');

    console.log(`\n完成，共 ${count} 张，输出目录：${OUT}\n`);
  } catch (err) {
    console.error('\n截图失败：', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
