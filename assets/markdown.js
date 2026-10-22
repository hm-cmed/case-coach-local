// =====================================================================
// markdown.js — AIの返答を表示するための小さな Markdown 変換
// まず全文を HTML エスケープしてから書式を当てるので、AIの出力に
// HTML やスクリプトが混ざっても実行されない（外部ライブラリ不要）。
// =====================================================================

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(raw) {
  const codes = [];
  let s = esc(raw).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const LIST_RE = /^(\s*)([-*+・]|\d+[.)．])\s+(.*)$/;

/**
 * @param {string} md
 * @param {{fence?: (lang:string, code:string, closed:boolean) => (string|null)}} [opts]
 *   fence が文字列を返したらその HTML を使い、null なら通常のコードブロックとして表示
 */
export function renderMarkdown(md, opts = {}) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const paragraph = [];
  const flushPara = () => {
    if (paragraph.length) { out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph.length = 0; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // コードブロック
    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      flushPara();
      const lang = fence[1].toLowerCase();
      const buf = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (/^\s*```\s*$/.test(lines[i])) { closed = true; i++; break; }
        buf.push(lines[i]); i++;
      }
      const code = buf.join('\n');
      const custom = opts.fence ? opts.fence(lang, code, closed) : null;
      out.push(custom ?? `<pre><code>${esc(code)}</code></pre>`);
      continue;
    }

    if (!line.trim()) { flushPara(); i++; continue; }

    // 見出し
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flushPara();
      const level = Math.min(6, h[1].length + 1); // 画面内の見出し階層に合わせて1段下げる
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++; continue;
    }

    // 区切り線
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

    // 表
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      out.push('<div class="md-table"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') +
        '</tr></thead><tbody>' + rows.map(r => '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }

    // 引用
    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }

    // 箇条書き（入れ子はインデント幅で判定）
    if (LIST_RE.test(line)) {
      flushPara();
      const stack = [];
      let html = '';
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (!m) {
          // 続きの行（字下げされた本文）は直前の項目に連結
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && stack.length) { html += '<br>' + inline(lines[i].trim()); i++; continue; }
          break;
        }
        const indent = m[1].replace(/\t/g, '    ').length;
        const ordered = /\d/.test(m[2]);
        const tag = ordered ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) { html += `</li></${stack.pop().tag}>`; }
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          const start = ordered ? parseInt(m[2], 10) : 1;
          html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
          stack.push({ indent, tag });
        } else {
          html += '</li>';
        }
        html += `<li>${inline(m[3])}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop().tag}>`;
      out.push(html);
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

export { esc as escapeHtml };
