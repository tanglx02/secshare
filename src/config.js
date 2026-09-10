'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const config = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',

  // 生产环境请务必通过环境变量覆盖
  sessionSecret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  sessionDays: Number(process.env.SESSION_DAYS || 14),

  // 管理员初始账号（仅首次初始化时生效，登录后请立即改密码）
  admin: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin888',
    nickname: '超级管理员',
  },

  paths: {
    data: path.join(ROOT, 'data'),
    dbFile: path.join(ROOT, 'data', 'db.json'),
    uploads: path.join(ROOT, 'public', 'uploads'),
    backups: path.join(ROOT, 'data', 'backups'),
  },

  upload: {
    maxSize: Number(process.env.UPLOAD_MAX_MB || 512) * 1024 * 1024, // 512MB
    imageTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon'],
    fileTypes: null, // 允许任意类型（软件包 / 资料）
  },

  // 是否开启“生产模式”安全策略（HTTPS 场景下建议 true）
  trustProxy: process.env.TRUST_PROXY === '1',
};

module.exports = config;
