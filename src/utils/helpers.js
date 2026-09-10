'use strict';

/** 转义 HTML（防 XSS），模板中所有用户输入必须经过此函数 */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 简易 slug（支持中文，用 id 兜底由调用方处理） */
function slugify(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatDate(date, withTime = false) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}

function timeAgo(date) {
  if (!date) return '';
  const diff = Date.now() - new Date(date).getTime();
  if (Number.isNaN(diff)) return '';
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return formatDate(date);
}

/** 数字缩写：12345 -> 1.2万 */
function compactNumber(n) {
  const num = Number(n) || 0;
  if (num < 10000) return String(num);
  if (num < 100000000) return `${(num / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return `${(num / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
}

function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatMoney(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

function parseMoney(yuan) {
  const n = Number(String(yuan).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** 从文本生成摘要 */
function excerpt(text, len = 120) {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*`_\-[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > len ? `${clean.slice(0, len)}…` : clean;
}

/** 分页助手 */
function paginate(total, page, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, page), pages);
  return {
    total, page: current, perPage, pages,
    offset: (current - 1) * perPage,
    hasPrev: current > 1,
    hasNext: current < pages,
    start: total === 0 ? 0 : (current - 1) * perPage + 1,
    end: Math.min(current * perPage, total),
    range: buildRange(current, pages),
  };
}

function buildRange(current, pages) {
  const out = [];
  const push = (v) => { if (!out.includes(v)) out.push(v); };
  push(1);
  for (let i = current - 2; i <= current + 2; i++) if (i > 1 && i < pages) push(i);
  if (pages > 1) push(pages);
  const withGaps = [];
  out.sort((a, b) => a - b).forEach((v, i, arr) => {
    if (i > 0 && v - arr[i - 1] > 1) withGaps.push('...');
    withGaps.push(v);
  });
  return withGaps;
}

/** 从 URL 提取域名，用于友链展示 */
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
}

module.exports = {
  esc, slugify, formatDate, timeAgo, compactNumber, formatSize,
  formatMoney, parseMoney, excerpt, paginate, domainOf,
};
