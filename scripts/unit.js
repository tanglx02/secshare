'use strict';

/**
 * 单元自测：签名/验签、密钥加解密、tar 打包解包
 * 运行：node scripts/unit.js
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const pay = require('../src/services/pay');
const backup = require('../src/services/backup');

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

console.log('\n=== SecShare 单元自测 ===\n');

// ---------------- 1. RSA2 签名 / 验签 ----------------
console.log('[1] 支付宝 RSA2 签名与验签');
const kpPkcs8 = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const kpPkcs1 = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

{
  const params = { app_id: '2021000', method: 'alipay.trade.query', charset: 'utf-8', biz_content: '{"out_trade_no":"SS1"}' };
  const sign = pay.signParams(params, kpPkcs8.privateKey);
  ok('参数签名可生成', typeof sign === 'string' && sign.length > 100);
  ok('PKCS8 私钥验签通过', pay.verifyParams(Object.assign({}, params, { sign }), kpPkcs8.publicKey) === true);
  ok('篡改参数后验签失败', pay.verifyParams(Object.assign({}, params, { sign, charset: 'gbk' }), kpPkcs8.publicKey) === false);
  ok('错误公钥验签失败', pay.verifyParams(Object.assign({}, params, { sign }), kpPkcs1.publicKey) === false);
  ok('待签串按字典序拼接', pay.buildSignContent({ b: '2', a: '1', sign: 'x' }) === 'a=1&b=2');
  ok('空值参数不参与签名', pay.buildSignContent({ a: '1', b: '', c: null }) === 'a=1');
}

console.log('\n[2] PKCS1 私钥与纯 base64 密钥识别');
{
  const bodyOnly = kpPkcs1.privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  ok('PKCS1 PEM 可识别', pay.normalizePrivateKey(kpPkcs1.privateKey) !== '');
  ok('纯 base64 私钥可识别', pay.normalizePrivateKey(bodyOnly) !== '');
  ok('无效私钥被拒绝', pay.normalizePrivateKey('not-a-key') === '');

  const pubBody = kpPkcs8.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  ok('公钥 PEM 可识别', pay.normalizePublicKey(kpPkcs8.publicKey) !== '');
  ok('纯 base64 公钥可识别', pay.normalizePublicKey(pubBody) !== '');
  ok('无效公钥被拒绝', pay.normalizePublicKey('garbage') === '');
}

console.log('\n[3] 密钥加密存储（AES-256-GCM）');
{
  const enc = pay.encryptSecret(kpPkcs8.privateKey);
  ok('密文带版本前缀', enc.startsWith('v1:'));
  ok('加密后可正确解密', pay.decryptSecret(enc) === kpPkcs8.privateKey);
  ok('密文不含明文特征', !enc.includes('BEGIN'));
  const tampered = `${enc.slice(0, -6)}AAAAAA`;
  ok('密文被篡改后解密失败（不抛出异常）', pay.decryptSecret(tampered) === '');
  ok('空值安全处理', pay.encryptSecret('') === '' && pay.decryptSecret('') === '');
}

// ---------------- 4. tar 打包 / 解包 ----------------
console.log('\n[4] tar.gz 打包与解包');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secshare-tar-'));
  const big = crypto.randomBytes(3000);
  fs.mkdirSync(path.join(tmp, 'uploads', 'images'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'db.json'), JSON.stringify({ meta: { version: 1 }, hello: '世界' }));
  fs.writeFileSync(path.join(tmp, 'uploads', 'images', '中文封面-测试.png'), big);
  fs.writeFileSync(path.join(tmp, 'uploads', 'note.txt'), 'small file');

  const entries = [
    { name: 'db.json', full: path.join(tmp, 'db.json') },
    { name: 'uploads/images/中文封面-测试.png', full: path.join(tmp, 'uploads', 'images', '中文封面-测试.png') },
    { name: 'uploads/note.txt', full: path.join(tmp, 'uploads', 'note.txt') },
  ];

  const tar = backup.buildTar(entries);
  ok('tar 数据块按 512 字节对齐', tar.length % 512 === 0);
  const gz = zlib.gzipSync(tar, { level: 6 });
  ok('gzip 压缩生效', gz.length < tar.length);

  const parsed = backup.parseTar(zlib.gunzipSync(gz));
  ok('解包条目数量一致', parsed.length === 3, `=> ${parsed.length}`);
  const byName = {};
  parsed.forEach((f) => { byName[f.name] = f.data; });
  ok('db.json 内容一致', byName['db.json'] && byName['db.json'].toString('utf8').includes('世界'));
  ok('中文文件名正确还原', !!byName['uploads/images/中文封面-测试.png']);
  ok('二进制内容完整（3000 字节）', byName['uploads/images/中文封面-测试.png'].length === 3000
    && Buffer.compare(byName['uploads/images/中文封面-测试.png'], big) === 0);
  ok('小文件内容正确', byName['uploads/note.txt'].toString('utf8') === 'small file');

  // 头部损坏检测（tar 头部校验和）
  const brokenHeader = Buffer.from(tar);
  brokenHeader[0] = brokenHeader[0] ^ 0xff;
  let threw = false;
  try { backup.parseTar(brokenHeader); } catch (_) { threw = true; }
  ok('tar 头部损坏能被检出', threw);

  // 内容损坏检测（gzip 自带 CRC32 校验，覆盖全部数据）
  const brokenData = Buffer.from(gz);
  brokenData[100] = brokenData[100] ^ 0xff;
  let gzThrew = false;
  try { zlib.gunzipSync(brokenData); } catch (_) { gzThrew = true; }
  ok('备份内容损坏能被检出（gzip CRC 校验）', gzThrew);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------- 5. 备份列表解析 ----------------
console.log('\n[5] 备份文件命名解析');
{
  const dir = backup.backupDir();
  ok('备份目录可创建', fs.existsSync(dir));
  const list = backup.listBackups();
  ok('备份列表可读取（返回数组）', Array.isArray(list));
  const fp = backup.siteFootprint();
  ok('站点体积统计可用', fp.dbSize > 0 && typeof fp.uploadFiles === 'number' && fp.counts.posts >= 0);
}

console.log(`\n=== 单元自测结果：通过 ${pass} 项，失败 ${fail} 项 ===\n`);
process.exit(fail === 0 ? 0 : 1);
