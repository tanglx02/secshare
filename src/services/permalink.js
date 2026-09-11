'use strict';

/**
 * 链接结构（Permalink）服务
 * - 后台可配置：结构（别名 / ID / ID-别名 / 分类-别名 / 类型-别名）、前缀、后缀
 * - 每篇文章拥有独立 slug（自动生成、可手动编辑）
 * - 路由层用它做规范化跳转：任何旧形式（数字 ID、旧前缀）都会 301 到当前规范地址
 */

const store = require('../db/store');
const { getSettings } = require('./settings');

const TYPE_SLUG = { software: 'software', doc: 'docs', news: 'news' };

const STRUCTURES = [
  { key: 'slug', label: '别名', desc: '例：/resource/nmap-795-zenmap', sample: 'resource/nmap-7-95' },
  { key: 'id', label: 'ID', desc: '例：/resource/12', sample: 'resource/12' },
  { key: 'id-slug', label: 'ID + 别名', desc: '例：/resource/12-nmap-795', sample: 'resource/12-nmap-7-95' },
  { key: 'category', label: '分类 / 别名', desc: '例：/penetration/nmap-795（忽略前缀）', sample: 'penetration/nmap-7-95' },
  { key: 'type', label: '类型 / 别名', desc: '例：/software/nmap-795（忽略前缀）', sample: 'software/nmap-7-95' },
];

function getPermalinkConfig() {
  const s = getSettings();
  return {
    structure: STRUCTURES.some((x) => x.key === s.permalinkStructure) ? s.permalinkStructure : 'slug',
    prefix: String(s.permalinkPrefix === undefined ? 'resource' : s.permalinkPrefix).replace(/^\/+|\/+$/g, ''),
    suffix: s.permalinkSuffix === '.html' ? '.html' : '',
    slugMode: s.slugMode === 'full' ? 'full' : 'auto',
    maxLength: Math.min(Math.max(Number(s.slugMaxLength) || 60, 20), 120),
  };
}

// ============================================================
// slug 生成
// ============================================================

/** 清洗文本为 URL 友好形式 */
function cleanSlug(text, keepChinese) {
  let s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/['"`’“”]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!keepChinese) {
    s = s.replace(/[\u4e00-\u9fa5]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  return s;
}

/**
 * 从标题生成别名
 * - auto（默认）：优先用标题里的英文与数字（工具名通常是英文），凑不出足够长度再退回完整标题
 * - full：中英文都保留（URL 里会出现中文，分享时编码较长）
 */
function generateSlug(title, fallbackId) {
  const cfg = getPermalinkConfig();
  const full = cleanSlug(title, true);
  let s = full;

  if (cfg.slugMode !== 'full') {
    const ascii = cleanSlug(title, false);
    const letters = (ascii.match(/[a-z]/g) || []).length;
    // 要求足够长且含足够字母，避免出现 "2-0-2026" 这类没有语义的别名
    if (ascii.length >= 6 && letters >= 3) s = ascii;
  }

  if (s.length > cfg.maxLength) {
    s = s.slice(0, cfg.maxLength).replace(/-[^-]*$/, '').replace(/-+$/, '');
  }
  if (!s) s = `p-${fallbackId || Date.now().toString(36)}`;
  return s;
}

/** 生成不冲突的别名 */
function uniqueSlug(base, excludeId) {
  let slug = base;
  let i = 2;
  while (store.findOne('posts', (p) => p.slug === slug && String(p.id) !== String(excludeId))) {
    slug = `${base}-${i}`;
    i++;
    if (i > 200) { slug = `${base}-${Date.now().toString(36)}`; break; }
  }
  return slug;
}

function ensureSlug(post, save = true) {
  if (post.slug) return post.slug;
  const slug = uniqueSlug(generateSlug(post.title, post.id), post.id);
  post.slug = slug;
  if (save) store.save();
  return slug;
}

/** 批量为缺少别名的文章生成 */
function generateAllSlugs() {
  let n = 0;
  store.all('posts').forEach((p) => {
    if (!p.slug) {
      p.slug = uniqueSlug(generateSlug(p.title, p.id), p.id);
      n++;
    }
  });
  if (n) store.save();
  return n;
}

// ============================================================
// 路径生成
// ============================================================

function categoryOf(post) {
  return post && post.categoryId ? store.findById('categories', post.categoryId) : null;
}

/** 生成文章规范路径（形如 /resource/xxx） */
function postPath(post, category) {
  if (!post) return '/';
  const cfg = getPermalinkConfig();
  const cat = category || categoryOf(post);
  const slug = post.slug || ensureSlug(post, false);
  let tail;

  switch (cfg.structure) {
    case 'id':
      tail = String(post.id);
      break;
    case 'id-slug':
      tail = `${post.id}-${slug}`;
      break;
    case 'category':
      tail = `${(cat && cat.slug) || 'uncategorized'}/${slug}`;
      break;
    case 'type':
      tail = `${TYPE_SLUG[post.type] || 'software'}/${slug}`;
      break;
    case 'slug':
    default:
      tail = slug;
      break;
  }

  const usePrefix = cfg.structure === 'slug' || cfg.structure === 'id' || cfg.structure === 'id-slug';
  const base = usePrefix && cfg.prefix ? `/${cfg.prefix}/` : '/';
  return `${base}${tail}${cfg.suffix}`;
}

/** 供模板使用的 URL（内部链接一律走这里，保证全站链接结构统一） */
function postUrl(post, category) {
  return postPath(post, category);
}

// ============================================================
// 反向解析
// ============================================================

/** 从 slug / id / id-slug 中定位文章 */
function resolveKey(key) {
  const raw = decodeURIComponent(String(key || '')).trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return store.findById('posts', raw);

  const m = raw.match(/^(\d+)-(.+)$/);
  if (m) {
    const byId = store.findById('posts', m[1]);
    if (byId) return byId;
    const bySlug = store.findOne('posts', (p) => p.slug === raw);
    if (bySlug) return bySlug;
    return store.findOne('posts', (p) => p.slug === m[2]);
  }

  const bySlug = store.findOne('posts', (p) => p.slug === raw);
  if (bySlug) return bySlug;

  // 兼容：后缀 .html 的情况
  const noSuffix = raw.replace(/\.html?$/i, '');
  return store.findOne('posts', (p) => p.slug === noSuffix);
}

/** 从两段路径解析（分类/别名、类型/别名、任意前缀/别名） */
function resolveSegments(first, second) {
  const a = decodeURIComponent(String(first || '')).trim();
  const b = decodeURIComponent(String(second || '')).trim();
  const cfg = getPermalinkConfig();

  // 1) 前缀 / 别名
  if (cfg.prefix && a === cfg.prefix) return resolveKey(b);

  // 2) 分类 / 别名
  const cat = store.findOne('categories', (c) => c.slug === a);
  if (cat) {
    const hit = store.findOne('posts', (p) => p.slug === b && String(p.categoryId) === String(cat.id))
      || resolveKey(b);
    if (hit) return hit;
  }

  // 3) 类型 / 别名
  const typeKey = Object.keys(TYPE_SLUG).find((k) => TYPE_SLUG[k] === a);
  if (typeKey) {
    const hit = store.findOne('posts', (p) => p.slug === b && (p.type || 'software') === typeKey);
    if (hit) return hit;
  }

  // 4) 任意前缀兜底（用户改过前缀后，历史链接仍可命中）
  return resolveKey(b);
}

/** 是否为当前规范地址（用于判断是否需要 301） */
function isCanonical(post, currentPath, category) {
  const target = postPath(post, category);
  const norm = (p) => decodeURIComponent(String(p || '')).replace(/\/+$/, '').toLowerCase();
  return norm(target) === norm(currentPath);
}

module.exports = {
  STRUCTURES, getPermalinkConfig,
  generateSlug, uniqueSlug, ensureSlug, generateAllSlugs,
  postPath, postUrl, resolveKey, resolveSegments, isCanonical,
};
