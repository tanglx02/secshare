'use strict';

/**
 * 轻量数据层：单文件 JSON 持久化 + 内存缓存 + 防抖原子写。
 * - 零原生依赖，Windows / Linux 开箱即用
 * - 对外暴露与 ORM 类似的集合 API，后续可平滑替换为 SQLite / MySQL 驱动
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const COLLECTIONS = [
  'users', 'posts', 'categories', 'tags', 'orders', 'plans',
  'ads', 'announcements', 'links', 'comments', 'downloads',
  'sessions', 'visits', 'favorites', 'notices', 'paylogs',
];

function emptyDB() {
  const db = { meta: { version: 1, createdAt: new Date().toISOString() } };
  for (const c of COLLECTIONS) db[c] = [];
  db.settings = {};
  db.counters = { post: 0, user: 0, order: 0 };
  return db;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = emptyDB();
    this._timer = null;
    this._writing = false;
    this._dirty = false;
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        const base = emptyDB();
        this.data = Object.assign(base, parsed);
        for (const c of COLLECTIONS) if (!Array.isArray(this.data[c])) this.data[c] = [];
        if (!this.data.settings) this.data.settings = {};
      } else {
        this.data = emptyDB();
        this.flush();
      }
    } catch (err) {
      // 数据文件损坏时备份并重建，避免服务无法启动
      const bak = this.file + '.corrupt-' + Date.now();
      try { fs.copyFileSync(this.file, bak); } catch (_) { /* ignore */ }
      console.error(`[store] 数据文件解析失败，已备份到 ${bak}，将重置为初始数据`);
      this.data = emptyDB();
      this.flush();
    }
    return this.data;
  }

  /** 标记脏数据，防抖 120ms 后写盘 */
  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 120);
    if (this._timer.unref) this._timer.unref();
  }

  /** 立即原子写盘 */
  flush() {
    if (this._writing) { this._dirty = true; return; }
    this._writing = true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      console.error('[store] 写入失败:', err.message);
    } finally {
      this._writing = false;
    }
  }

  // ---------- 通用集合 API ----------
  col(name) {
    if (!Array.isArray(this.data[name])) this.data[name] = [];
    return this.data[name];
  }

  all(name) { return this.col(name).slice(); }

  find(name, predicate) { return this.col(name).filter(predicate); }

  findOne(name, predicate) { return this.col(name).find(predicate) || null; }

  findById(name, id) { return this.col(name).find((r) => String(r.id) === String(id)) || null; }

  insert(name, record) {
    const rows = this.col(name);
    const row = Object.assign({ id: this.nextId(name), createdAt: new Date().toISOString() }, record);
    rows.push(row);
    this.save();
    return row;
  }

  update(name, id, patch) {
    const row = this.findById(name, id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  remove(name, id) {
    const rows = this.col(name);
    const idx = rows.findIndex((r) => String(r.id) === String(id));
    if (idx === -1) return false;
    rows.splice(idx, 1);
    this.save();
    return true;
  }

  removeWhere(name, predicate) {
    const rows = this.col(name);
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (predicate(rows[i])) { rows.splice(i, 1); n++; }
    }
    if (n) this.save();
    return n;
  }

  count(name, predicate) {
    if (!predicate) return this.col(name).length;
    return this.col(name).reduce((acc, r) => acc + (predicate(r) ? 1 : 0), 0);
  }

  nextId(name) {
    if (!this.data.counters) this.data.counters = {};
    const key = name.replace(/s$/, '');
    this.data.counters[key] = (this.data.counters[key] || 0) + 1;
    return this.data.counters[key];
  }

  // ---------- 设置项 ----------
  getSetting(key, fallback) {
    const s = this.data.settings || {};
    return s[key] === undefined ? fallback : s[key];
  }

  setSetting(key, value) {
    if (!this.data.settings) this.data.settings = {};
    this.data.settings[key] = value;
    this.save();
  }

  setSettings(obj) {
    if (!this.data.settings) this.data.settings = {};
    Object.assign(this.data.settings, obj);
    this.save();
  }

  // ---------- 备份 ----------
  backup() {
    fs.mkdirSync(config.paths.backups, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(config.paths.backups, `db-${stamp}.json`);
    fs.writeFileSync(dest, JSON.stringify(this.data, null, 2), 'utf8');
    return dest;
  }

  /** 进程退出前确保落盘 */
  installExitHooks() {
    const onExit = () => { try { this.flush(); } catch (_) { /* ignore */ } };
    process.on('exit', onExit);
    process.on('SIGINT', () => { onExit(); process.exit(0); });
    process.on('SIGTERM', () => { onExit(); process.exit(0); });
  }
}

const store = new Store(config.paths.dbFile);

module.exports = store;
module.exports.COLLECTIONS = COLLECTIONS;
