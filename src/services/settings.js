'use strict';

const store = require('../db/store');

/** 站点默认设置（后台「系统设置」可覆盖） */
const DEFAULTS = {
  siteName: 'SecShare 安全资源站',
  siteSubtitle: '工欲善其事，必先利其器',
  siteDescription: '专注网络安全工具、渗透测试资源与安全学习资料分享的平台',
  siteKeywords: '网络安全,渗透测试,安全工具,安全资料,CTF,漏洞分析',
  siteUrl: 'http://localhost:3000',
  logoText: 'SecShare',
  logoImage: '',
  icp: '',
  police: '',
  contactEmail: 'admin@example.com',
  contactWechat: '',
  contactQQ: '',

  // 内容与访问策略
  commentsEnabled: true,
  registerEnabled: true,
  registerNeedInvite: false,
  inviteCode: 'SEC2026',
  downloadNeedLogin: true,
  defaultDownloadMode: 'vip', // free | login | points | vip | paid
  pointsPerRegister: 10,
  pointsPerDownload: 0,

  // 变现
  adsEnabled: true,
  vipEnabled: true,
  shopEnabled: true,
  adTopBanner: '',
  adSidebar: '',
  adFloat: '',
  adDetailTop: '',
  // 自定义 HTML 广告（可粘贴广告联盟代码）
  adTopBannerHtml: '',
  adSidebarHtml: '',
  adFloatHtml: '',
  adDetailTopHtml: '',
  moneyUnit: '¥',

  // 支付宝支付（密钥在后台「支付设置」单独保存，此处仅存非敏感项）
  alipayEnabled: false,
  alipayMode: 'sandbox',        // sandbox（沙箱）| production（生产）
  alipayAppId: '',
  alipayPayType: 'qr',          // qr（当面付/扫码）| page（电脑网站支付）
  alipayGateway: '',            // 留空按模式取默认网关
  alipayNotifyUrl: '',          // 留空自动使用「站点域名 + /api/pay/alipay/notify」
  alipayReturnUrl: '',          // 留空自动跳回订单页
  alipaySellerId: '',           // 可选，填了会做收款账号校验
  alipaySubjectPrefix: '',      // 订单标题前缀，如站点名

  // 全站备份
  backupAutoEnabled: true,
  backupIntervalHours: 24,
  backupKeep: 7,
  backupIncludeUploads: true,
  backupDir: '',                // 留空使用 data/backups
  lastAutoBackupAt: '',
  lastBackupAt: '',

  // 邮件服务与注册验证（密码在「邮件设置」单独加密保存）
  mailEnabled: false,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpFromName: '',
  smtpFromEmail: '',
  registerNeedEmailVerify: false,   // 注册必须邮箱验证码
  registerIpDailyLimit: 3,          // 同 IP 24 小时注册上限，0 = 不限制
  mailEchoCode: false,              // 仅调试用：未配置 SMTP 时把验证码回显到页面（生产务必关闭）

  // 链接结构（Permalink）
  permalinkStructure: 'slug',       // slug | id | id-slug | category | type
  permalinkPrefix: 'resource',      // 自定义前缀，如 tools / soft
  permalinkSuffix: '',              // '' 或 '.html'
  slugMode: 'auto',                 // auto（优先英文数字，URL 更干净）| full（保留中文）
  slugMaxLength: 60,                // 别名最大长度

  // SEO 增强
  ogImage: '',                      // 社交分享默认图
  verifyGoogle: '',                 // 各站长平台验证 meta 的 content 值
  verifyBing: '',
  verifyBaidu: '',
  verify360: '',
  verifySogou: '',
  searchPageNoindex: true,          // 搜索/筛选页 noindex，避免低质页面进索引
  enableStructuredData: true,       // 输出 JSON-LD 结构化数据

  // 统计与 SEO
  statsCode: '',
  siteFooterNote: '本站所有资源均来自互联网收集，仅供安全研究与学习交流使用，请于下载后 24 小时内删除。',
  disclaimer: `1、本站为网络安全技术交流平台，所有内容仅供安全研究与学习测试使用，严禁用于任何非法用途。
2、用户下载的资源请在 24 小时内自行删除，因使用本站资源产生的一切后果由使用者自行承担。
3、本站尊重知识产权，如权利人认为内容侵犯其合法权益，请联系我们并提供权属证明，我们将第一时间处理。
4、禁止利用本站传播恶意程序、病毒木马、破解工具或从事任何违反《中华人民共和国网络安全法》的行为。`,
  aboutUs: 'SecShare 安全资源站由一线网络安全工程师维护，长期分享实战可用、安全合法的安全工具与学习资料。',
};

function getSettings() {
  const saved = store.data.settings || {};
  return Object.assign({}, DEFAULTS, saved);
}

function getSetting(key) {
  return getSettings()[key];
}

module.exports = { DEFAULTS, getSettings, getSetting };
