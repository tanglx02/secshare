'use strict';

/**
 * 极简 Markdown 渲染器（无第三方依赖）
 * 支持：标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 链接 / 图片 / 无序·有序列表 / 引用 / 分割线 / 表格 / 段落
 * 所有原始 HTML 会被转义，保证安全。
 */

const { esc } = require('./helpers');

function inline(text) {
  let s = esc(text);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

function render(md) {
  if (!md) return '';
  const src = String(md).replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let listType = null; // 'ul' | 'ol'
  let tableBuf = [];

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map((r) => r.split('|').map((c) => c.trim()).filter((c, i, a) => !(i === 0 && c === '') && !(i === a.length - 1 && c === '')));
    const head = rows[0];
    const body = rows.slice(rows[1] && /^[-:\s]+$/.test(rows[1].join('')) ? 2 : 1);
    out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
    body.forEach((r) => { out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>'); });
    out.push('</tbody></table>');
    tableBuf = [];
  };

  for (const raw of lines) {
    const line = raw;

    if (/^\s*```/.test(line)) {
      if (!inCode) { closeList(); flushTable(); inCode = true; codeBuf = []; }
      else { out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`); inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); tableBuf.push(line.trim()); continue; }
    else if (tableBuf.length) flushTable();

    if (!line.trim()) { closeList(); continue; }

    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lv = m[1].length;
      out.push(`<h${lv} id="${esc(m[2].trim().toLowerCase().replace(/\s+/g, '-'))}">${inline(m[2])}</h${lv}>`);
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }

  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  closeList();
  flushTable();
  return out.join('\n');
}

module.exports = { render };
