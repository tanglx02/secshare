'use strict';

const store = require('../db/store');
const { paginate, excerpt } = require('../utils/helpers');

// ============ 分类 ============
function listCategories() {
  return store.all('categories').sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100));
}

function categoryTree() {
  const all = listCategories();
  const roots = all.filter((c) => !c.parentId);
  return roots.map((r) => Object.assign({}, r, {
    children: all.filter((c) => String(c.parentId) === String(r.id)),
  }));
}

function getCategoryBySlug(slug) {
  return store.findOne('categories', (c) => c.slug === slug || String(c.id) === String(slug));
}

// ============ 标签 ============
function listTags() {
  return store.all('tags').sort((a, b) => (b.count || 0) - (a.count || 0));
}

function getTagBySlug(slug) {
  return store.findOne('tags', (t) => t.slug === slug || String(t.id) === String(slug));
}

function syncTagCounts() {
  const tags = store.all('tags');
  tags.forEach((t) => {
    t.count = store.count('posts', (p) => p.status === 'published' && Array.isArray(p.tags) && p.tags.includes(t.name));
  });
  store.save();
}

function ensureTags(names = []) {
  names.forEach((name) => {
    const clean = String(name).trim();
    if (!clean) return;
    const exists = store.findOne('tags', (t) => t.name === clean);
    if (!exists) store.insert('tags', { name: clean, slug: clean, count: 0 });
  });
}

// ============ 内容（资源 / 文章） ============
function queryPosts(opts = {}) {
  const {
    type, categoryId, tag, status = 'published', keyword, sort = 'new',
    featured, recommended, page = 1, perPage = 15, level, includeAll = false,
  } = opts;

  let rows = store.all('posts');
  if (!includeAll) rows = rows.filter((p) => p.status === status);
  if (type) rows = rows.filter((p) => (p.type || 'software') === type);
  if (categoryId) rows = rows.filter((p) => String(p.categoryId) === String(categoryId));
  if (level) rows = rows.filter((p) => (p.accessLevel || 'vip') === level);
  if (tag) rows = rows.filter((p) => Array.isArray(p.tags) && p.tags.includes(tag));
  if (featured) rows = rows.filter((p) => p.featured);
  if (recommended) rows = rows.filter((p) => p.recommended);
  if (keyword) {
    const kw = String(keyword).toLowerCase();
    rows = rows.filter((p) => {
      const hay = [p.title, p.summary, p.content, (p.tags || []).join(' '), p.version, p.author].join(' ').toLowerCase();
      return hay.includes(kw);
    });
  }

  const sorters = {
    new: (a, b) => new Date(b.publishedAt || b.createdAt) - new Date(a.publishedAt || a.createdAt),
    hot: (a, b) => (b.views || 0) - (a.views || 0),
    download: (a, b) => (b.downloads || 0) - (a.downloads || 0),
    update: (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt),
  };
  rows.sort(sorters[sort] || sorters.new);

  // 置顶优先
  rows.sort((a, b) => (b.top ? 1 : 0) - (a.top ? 1 : 0));

  const pager = paginate(rows.length, Number(page) || 1, perPage);
  return { list: rows.slice(pager.offset, pager.offset + pager.perPage), pager };
}

function getPost(idOrSlug) {
  return store.findOne('posts', (p) => String(p.id) === String(idOrSlug) || p.slug === idOrSlug);
}

function relatedPosts(post, limit = 6) {
  if (!post) return [];
  let rows = store.find('posts', (p) => p.status === 'published' && p.id !== post.id
    && (String(p.categoryId) === String(post.categoryId)
      || (p.tags || []).some((t) => (post.tags || []).includes(t))));
  rows.sort((a, b) => (b.views || 0) - (a.views || 0));
  return rows.slice(0, limit);
}

function bumpViews(id) {
  const post = store.findById('posts', id);
  if (!post) return;
  post.views = (post.views || 0) + 1;
  store.save();
}

function bumpDownloads(id) {
  const post = store.findById('posts', id);
  if (!post) return;
  post.downloads = (post.downloads || 0) + 1;
  store.save();
}

function postSummary(post, categoryMap) {
  const cat = categoryMap ? categoryMap[post.categoryId] : store.findById('categories', post.categoryId);
  return Object.assign({}, post, { categoryName: cat ? cat.name : '未分类', categorySlug: cat ? cat.slug : '' });
}

// ============ 公告 / 友链 / 广告 ============
function activeAnnouncements(limit = 5) {
  return store.all('announcements')
    .filter((a) => a.active !== false)
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .slice(0, limit);
}

function activeLinks() {
  return store.all('links').filter((l) => l.active !== false).sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100));
}

function activeAds(position) {
  return store.all('ads').filter((a) => a.active !== false && (!position || a.position === position));
}

function adFor(position) {
  const list = activeAds(position);
  if (!list.length) return null;
  // 简单轮询曝光
  const ad = list[Math.floor(Math.random() * list.length)];
  ad.views = (ad.views || 0) + 1;
  store.save();
  return ad;
}

// ============ 评论 ============
function listComments(postId, onlyApproved = true) {
  return store.find('comments', (c) => String(c.postId) === String(postId) && (!onlyApproved || c.status !== 'pending'))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = {
  listCategories, categoryTree, getCategoryBySlug,
  listTags, getTagBySlug, syncTagCounts, ensureTags,
  queryPosts, getPost, relatedPosts, bumpViews, bumpDownloads, postSummary,
  activeAnnouncements, activeLinks, activeAds, adFor, listComments,
  excerpt,
};
