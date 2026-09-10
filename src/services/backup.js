'use strict';

/**
 * 全站备份服务
 * - 备份内容：data/db.json + public/uploads/**（可配置是否包含上传文件）
 * - 输出格式：.tar.gz（纯 Node 实现，无第三方依赖，Windows / Linux 均可解压）
 * - 支持：手动备份、定时自动备份、保留份数滚动清理、上传恢复、恢复前自动快照
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const config = require('../config');
const store = require('../db/store');
const { getSettings } = require('./settings');

const BACKUP_EXT = '.tar.gz';
const TAR_BLOCK = 512;

// ============================================================
// tar 写入
// ============================================================

/** 以八进制写入定长字段 */
function writeOctal(buf, offset, length, value) {
  const str = Math.max(0, Math.floor(Number(value) || 0)).toString(8);
  const body = str.length > length - 1 ? str.slice(-(length - 1)) : str;
  buf.write(body.padStart(length - 1, '0'), offset, length - 1, 'ascii');
  buf.writeUInt8(0, offset + length - 1);
}

/** 构造 512 字节 tar 头 */
function tarHeader(name, size, mtimeSec, isDir) {
  const buf = Buffer.alloc(TAR_BLOCK);
  const clean = String(name).replace(/\\/g, '/');

  let fileName = clean;
  let prefix = '';
  if (Buffer.byteLength(clean, 'utf8') > 100) {
    // 拆到 prefix 字段（ustar 扩展）
    const idx = clean.lastIndexOf('/', clean.length - 100);
    if (idx > 0 && Buffer.byteLength(clean.slice(0, idx), 'utf8') <= 155) {
      prefix = clean.slice(0, idx);
      fileName = clean.slice(idx + 1);
    } else {
      fileName = clean.slice(-100);
    }
  }

  buf.write(fileName, 0, 100, 'utf8');
  writeOctal(buf, 100, 8, isDir ? 0o755 : 0o644);
  writeOctal(buf, 108, 8, 0);
  writeOctal(buf, 116, 8, 0);
  writeOctal(buf, 124, 12, isDir ? 0 : size);
  writeOctal(buf, 136, 12, mtimeSec);

  buf.fill(0x20, 148, 156);           // 校验和字段先填空格
  buf.write(isDir ? '5' : '0', 156, 1, 'ascii');
  buf.write('ustar', 257, 5, 'ascii'); // magic
  buf.writeUInt8(0, 262);
  buf.write('00', 263, 2, 'ascii');    // version
  buf.write('secshare', 265, 32, 'ascii');
  buf.write('secshare', 297, 32, 'ascii');
  if (prefix) buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  buf.writeUInt8(0, 154);
  buf.writeUInt8(0x20, 155);
  return buf;
}

/** 递归收集目录下的所有文件 */
function collectFiles(dir, prefix) {
  const out = [];
  const walk = (current) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(dir, full).split(path.sep).join('/');
        out.push({ name: `${prefix}/${rel}`, full });
      }
    }
  };
  walk(dir);
  return out;
}

/** 把条目打包成 tar（未压缩）；条目支持 { name, full } 文件与 { name, dir:true } 目录 */
function buildTar(entries) {
  const chunks = [];
  const now = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    if (e.dir) {
      chunks.push(tarHeader(e.name.endsWith('/') ? e.name : `${e.name}/`, 0, now, true));
      continue;
    }
    let stat;
    let data;
    try {
      stat = fs.statSync(e.full);
      data = fs.readFileSync(e.full);
    } catch (_) { continue; }
    chunks.push(tarHeader(e.name, data.length, Math.floor(stat.mtimeMs / 1000)));
    chunks.push(data);
    const pad = (TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2)); // 结束标记
  return Buffer.concat(chunks);
}

// ============================================================
// tar 读取
// ============================================================

function parseOctal(buf) {
  const str = buf.toString('ascii').replace(/\0.*$/, '').trim();
  return str ? parseInt(str, 8) || 0 : 0;
}

/** 解析 tar buffer，返回 [{ name, data }] */
function parseTar(buf) {
  const files = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + TAR_BLOCK);
    // 结束块：全 0
    let allZero = true;
    for (let i = 0; i < TAR_BLOCK; i++) { if (header[i] !== 0) { allZero = false; break; } }
    if (allZero) break;

    const storedSum = parseOctal(header.subarray(148, 156));
    let calcSum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) calcSum += (i >= 148 && i < 156) ? 0x20 : header[i];
    if (storedSum !== 0 && storedSum !== calcSum) {
      throw new Error('备份文件已损坏（tar 校验和不匹配）');
    }

    let name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;

    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]);
    const dataStart = offset + TAR_BLOCK;

    if (type === '0' || type === '\0' || type === '') {
      if (name) files.push({ name, data: buf.subarray(dataStart, dataStart + size) });
    }
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return files;
}

// ============================================================
// 目录与列表
// ============================================================

function backupDir() {
  const custom = getSettings().backupDir;
  const dir = custom ? path.resolve(String(custom)) : config.paths.backups;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseBackupName(name) {
  // manual-20260911-041500-full.tar.gz
  const m = String(name).match(/^(auto|manual)-(\d{8})-(\d{6})-(full|data)\.tar\.gz$/);
  if (!m) return { isAuto: false, kind: 'unknown', time: null };
  const [, prefix, date, time, scope] = m;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  return { isAuto: prefix === 'auto', scope, kind: scope === 'full' ? '全量（数据 + 上传文件）' : '仅数据', time: iso };
}

function listBackups() {
  const dir = backupDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter((n) => n.endsWith(BACKUP_EXT))
    .map((n) => {
      let stat = { size: 0, mtime: new Date() };
      try { stat = fs.statSync(path.join(dir, n)); } catch (_) { /* ignore */ }
      return Object.assign({ name: n, size: stat.size, mtime: stat.mtime, path: path.join(dir, n) }, parseBackupName(n));
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ============================================================
// 备份 / 恢复
// ============================================================

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * 创建备份
 * @param {{ includeUploads?: boolean, isAuto?: boolean, note?: string }} opts
 */
function createBackup(opts = {}) {
  const settings = getSettings();
  const includeUploads = opts.includeUploads !== undefined
    ? !!opts.includeUploads
    : settings.backupIncludeUploads !== false;

  store.flush(); // 确保 db.json 落盘后再打包

  const entries = [{ name: 'db.json', full: config.paths.dbFile }];
  if (includeUploads && fs.existsSync(config.paths.uploads)) {
    entries.push({ name: 'uploads/', dir: true }); // 保留目录结构，便于解压后直接辨认
    entries.push(...collectFiles(config.paths.uploads, 'uploads'));
  }

  const tar = buildTar(entries);
  const gz = zlib.gzipSync(tar, { level: 6 });

  const prefix = opts.isAuto ? 'auto' : 'manual';
  const scope = includeUploads ? 'full' : 'data';
  const name = `${prefix}-${timestamp()}-${scope}${BACKUP_EXT}`;
  const dest = path.join(backupDir(), name);
  fs.writeFileSync(dest, gz);

  const now = new Date().toISOString();
  const patch = { lastBackupAt: now };
  if (opts.isAuto) patch.lastAutoBackupAt = now;
  store.setSettings(patch);

  pruneBackups();

  return {
    name, path: dest, size: gz.length, rawSize: tar.length,
    fileCount: entries.filter((e) => !e.dir).length, includeUploads,
    compressRate: tar.length ? (1 - gz.length / tar.length) : 0,
  };
}

/** 清理超出保留份数的「自动备份」（手动备份不会被自动删除） */
function pruneBackups(keep) {
  const limit = Number(keep || getSettings().backupKeep || 7);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const autos = listBackups().filter((b) => b.isAuto);
  let removed = 0;
  autos.slice(limit).forEach((b) => {
    try { fs.unlinkSync(b.path); removed++; } catch (_) { /* ignore */ }
  });
  return removed;
}

function deleteBackup(name) {
  const safe = path.basename(String(name));
  const full = path.join(backupDir(), safe);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}

/** 恢复前做一次安全快照，避免误操作无法回退 */
function snapshotBeforeRestore() {
  try {
    return createBackup({ isAuto: false });
  } catch (err) {
    console.error('[backup] 恢复前快照失败:', err.message);
    return null;
  }
}

/**
 * 从备份 buffer 或文件路径恢复
 * @returns {{ db:boolean, files:number, skipped:string[] }}
 */
function restoreBackup(source) {
  const gz = Buffer.isBuffer(source) ? source : fs.readFileSync(source);

  let tar;
  try {
    tar = zlib.gunzipSync(gz);
  } catch (_) {
    throw new Error('无法解压：请确认上传的是本站导出的 .tar.gz 备份包');
  }

  const files = parseTar(tar);
  if (!files.length) throw new Error('备份包内容为空或格式不正确');

  // 路径安全校验（防目录穿越）
  for (const f of files) {
    const n = f.name;
    if (n.includes('..') || path.isAbsolute(n) || /^[a-zA-Z]:/.test(n)) {
      throw new Error(`备份包含非法路径：${n}`);
    }
  }

  const hasDb = files.some((f) => f.name === 'db.json');
  if (!hasDb) throw new Error('备份包中未找到 db.json，无法恢复');

  snapshotBeforeRestore();
  store.flush();

  let restoredFiles = 0;
  const uploadsRoot = path.resolve(config.paths.uploads);

  for (const f of files) {
    if (f.name === 'db.json') {
      JSON.parse(f.data.toString('utf8')); // 校验 JSON 合法性，损坏则直接抛错
      fs.writeFileSync(config.paths.dbFile, f.data);
      continue;
    }
    if (f.name.startsWith('uploads/')) {
      const relative = f.name.slice('uploads/'.length);
      const target = path.resolve(path.join(config.paths.uploads, relative));
      if (!target.startsWith(uploadsRoot)) throw new Error(`备份包含非法路径：${f.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
      restoredFiles++;
    }
  }

  // 重新载入内存数据
  store.load();

  return { db: hasDb, files: restoredFiles, total: files.length };
}

// ============================================================
// 站点体积统计
// ============================================================

function siteFootprint() {
  let uploadFiles = 0;
  let uploadBytes = 0;
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        uploadFiles++;
        try { uploadBytes += fs.statSync(full).size; } catch (_) { /* ignore */ }
      }
    }
  })(config.paths.uploads);

  let dbSize = 0;
  try { dbSize = fs.statSync(config.paths.dbFile).size; } catch (_) { /* ignore */ }

  return {
    dbSize,
    uploadFiles,
    uploadBytes,
    total: dbSize + uploadBytes,
    counts: {
      posts: store.count('posts'),
      users: store.count('users'),
      orders: store.count('orders'),
      comments: store.count('comments'),
      downloads: store.count('downloads'),
    },
  };
}

// ============================================================
// 定时自动备份
// ============================================================

let timer = null;

function runAutoBackupOnce(force = false) {
  const s = getSettings();
  if (!force && s.backupAutoEnabled === false) return null;
  const hours = Number(s.backupIntervalHours) || 24;
  const last = s.lastAutoBackupAt ? new Date(s.lastAutoBackupAt).getTime() : 0;
  if (!force && last && Date.now() - last < hours * 3600000) return null;

  const result = createBackup({ isAuto: true, includeUploads: s.backupIncludeUploads !== false });
  console.log(`[backup] 自动备份完成 ${result.name} · ${(result.size / 1024).toFixed(1)} KB · ${result.fileCount} 个文件`);
  return result;
}

function startAutoBackup() {
  if (timer) return;
  const tick = () => {
    try { runAutoBackupOnce(); } catch (err) { console.error('[backup] 自动备份失败:', err.message); }
  };
  // 启动 45 秒后检查一次（避开启动高峰），之后每小时检查
  const first = setTimeout(tick, 45 * 1000);
  if (first.unref) first.unref();
  timer = setInterval(tick, 60 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = {
  backupDir, listBackups, createBackup, restoreBackup, deleteBackup,
  pruneBackups, siteFootprint, startAutoBackup, runAutoBackupOnce,
  parseTar, buildTar, BACKUP_EXT,
};
