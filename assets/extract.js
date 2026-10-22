// =====================================================================
// extract.js — ファイルからの文字抽出と、アプリによる機械的な計測
// すべてブラウザ内で処理し、どこにも送信しない。
//   .pptx / .docx … ブラウザ標準の解凍機能（DecompressionStream）で中身のXMLを読む
//   .pdf          … 同梱の pdf.js（vendor/pdfjs）で文字抽出・ページ画像化
//   .txt / .md    … UTF-8 / Shift_JIS を自動判別
// =====================================================================

const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};

// ---------------------------------------------------------------------
// 最小限の ZIP 読み取り（Office 文書用）
// ---------------------------------------------------------------------
async function openZip(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ファイルを開けませんでした（Office 形式ではないか、破損しています）。');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = dec.decode(new Uint8Array(buf, off + 46, nlen));
    entries.set(name, { method, csize, lho });
    off += 46 + nlen + elen + clen;
  }
  async function bytes(name) {
    const e = entries.get(name);
    if (!e) return null;
    const nlen = dv.getUint16(e.lho + 26, true);
    const elen = dv.getUint16(e.lho + 28, true);
    const data = new Uint8Array(buf, e.lho + 30 + nlen + elen, e.csize);
    if (e.method === 0) return data.slice();
    if (e.method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('対応していない圧縮形式です。');
  }
  return {
    names: () => [...entries.keys()],
    async xml(name) {
      const b = await bytes(name);
      if (!b) return null;
      return new DOMParser().parseFromString(new TextDecoder().decode(b), 'application/xml');
    },
  };
}

function resolvePath(fromFile, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromFile.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function readRels(zip, relsPath) {
  const doc = await zip.xml(relsPath);
  const map = new Map();
  if (!doc) return map;
  for (const el of doc.getElementsByTagNameNS(NS.rel, 'Relationship')) {
    map.set(el.getAttribute('Id'), { type: el.getAttribute('Type') || '', target: el.getAttribute('Target') || '' });
  }
  return map;
}

function paragraphs(root, ns) {
  const out = [];
  for (const p of root.getElementsByTagNameNS(ns, 'p')) {
    let s = '';
    const walker = p.ownerDocument.createTreeWalker(p, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      if (node.namespaceURI === ns && node.localName === 't') s += node.textContent;
      else if (node.localName === 'tab') s += '\t';
      else if (node.localName === 'br') s += '\n';
      node = walker.nextNode();
    }
    s = s.replace(/[ 　]+$/g, '');
    if (s.trim()) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------
async function extractPptx(buf) {
  const zip = await openZip(buf);
  const pres = await zip.xml('ppt/presentation.xml');
  const presRels = await readRels(zip, 'ppt/_rels/presentation.xml.rels');
  let slidePaths = [];
  if (pres) {
    for (const s of pres.getElementsByTagNameNS(NS.p, 'sldId')) {
      const rid = s.getAttributeNS(NS.r, 'id') || s.getAttribute('r:id');
      const rel = presRels.get(rid);
      if (rel) slidePaths.push(resolvePath('ppt/presentation.xml', rel.target));
    }
  }
  if (!slidePaths.length) {
    slidePaths = zip.names().filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  }

  const slides = [];
  for (const path of slidePaths) {
    const doc = await zip.xml(path);
    if (!doc) continue;
    let title = '';
    const body = [];
    for (const sp of doc.getElementsByTagNameNS(NS.p, 'sp')) {
      const ph = sp.getElementsByTagNameNS(NS.p, 'ph')[0];
      const phType = ph?.getAttribute('type') || '';
      if (['sldNum', 'dt', 'ftr'].includes(phType)) continue;
      const txBody = sp.getElementsByTagNameNS(NS.p, 'txBody')[0];
      if (!txBody) continue;
      const lines = paragraphs(txBody, NS.a);
      if (!lines.length) continue;
      if (!title && (phType === 'title' || phType === 'ctrTitle')) title = lines.join(' ');
      else body.push(...lines);
    }
    // 表（graphicFrame 内の a:tbl）
    for (const tbl of doc.getElementsByTagNameNS(NS.a, 'tbl')) {
      for (const tr of tbl.getElementsByTagNameNS(NS.a, 'tr')) {
        const cells = [...tr.getElementsByTagNameNS(NS.a, 'tc')].map(tc => paragraphs(tc, NS.a).join(' '));
        if (cells.some(c => c.trim())) body.push('｜' + cells.join('｜') + '｜');
      }
    }
    const pictures = doc.getElementsByTagNameNS(NS.p, 'pic').length;
    let charts = 0;
    for (const gd of doc.getElementsByTagNameNS(NS.a, 'graphicData')) {
      if ((gd.getAttribute('uri') || '').includes('/chart')) charts++;
    }
    // 発表者ノート
    let notes = '';
    const rels = await readRels(zip, path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels'));
    for (const rel of rels.values()) {
      if (rel.type.endsWith('/notesSlide')) {
        const nd = await zip.xml(resolvePath(path, rel.target));
        if (nd) {
          const parts = [];
          for (const sp of nd.getElementsByTagNameNS(NS.p, 'sp')) {
            const ph = sp.getElementsByTagNameNS(NS.p, 'ph')[0];
            if (ph?.getAttribute('type') !== 'body') continue;
            const txBody = sp.getElementsByTagNameNS(NS.p, 'txBody')[0];
            if (txBody) parts.push(...paragraphs(txBody, NS.a));
          }
          notes = parts.join('\n');
        }
      }
    }
    slides.push({ title, body, pictures, charts, notes });
  }
  if (!slides.length) throw new Error('スライドが見つかりませんでした。');
  return { kind: 'slides', text: formatSlides(slides), pages: slides.length };
}

export function formatSlides(slides) {
  return slides.map((s, i) => {
    const out = [`=== スライド ${i + 1} ===`];
    if (s.title) out.push(`タイトル：${s.title}`);
    for (const l of s.body) out.push(l);
    const fig = [];
    if (s.pictures) fig.push(`画像${s.pictures}`);
    if (s.charts) fig.push(`グラフ${s.charts}`);
    if (fig.length) out.push(`図表：${fig.join('、')}`);
    if (s.notes) out.push(`ノート：${s.notes}`);
    return out.join('\n');
  }).join('\n\n');
}

// ---------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------
async function extractDocx(buf) {
  const zip = await openZip(buf);
  const doc = await zip.xml('word/document.xml');
  if (!doc) throw new Error('Word 文書の本文が見つかりませんでした。');
  const body = doc.getElementsByTagNameNS(NS.w, 'body')[0] || doc;
  return { kind: 'text', text: paragraphs(body, NS.w).join('\n') };
}

// ---------------------------------------------------------------------
// PDF（同梱 pdf.js を必要になったときだけ読み込む）
// ---------------------------------------------------------------------
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/pdfjs/pdf.min.js', import.meta.url).href;
      s.onload = () => {
        const lib = window.pdfjsLib;
        if (!lib) return reject(new Error('PDF 読み取り部品を読み込めませんでした。'));
        lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
        resolve(lib);
      };
      s.onerror = () => reject(new Error('PDF 読み取り部品を読み込めませんでした。'));
      document.head.appendChild(s);
    });
  }
  return pdfjsPromise;
}

const CJK = /[　-ヿ㐀-鿿＀-￯]/;

async function extractPdf(buf, { asSlides, renderImages, maxImages }) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const pageTexts = [];
  const images = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let s = '';
    for (const it of tc.items) {
      const str = it.str || '';
      if (s && str && !s.endsWith('\n')) {
        const prev = s[s.length - 1];
        if (!CJK.test(prev) && !CJK.test(str[0]) && prev !== ' ' && str[0] !== ' ') s += ' ';
      }
      s += str;
      if (it.hasEOL) s += '\n';
    }
    pageTexts.push(s.replace(/\n{3,}/g, '\n\n').trim());

    if (renderImages && images.length < maxImages) {
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1024 / base.width);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.82));
    }
    page.cleanup();
  }
  await pdf.destroy();

  const totalChars = pageTexts.join('').replace(/\s/g, '').length;
  const scanned = totalChars < pdf.numPages * 5;

  if (asSlides) {
    const text = pageTexts.map((t, i) => `=== スライド ${i + 1} ===\n${t}`).join('\n\n');
    return { kind: 'slides', text, pages: pdf.numPages, images, scanned };
  }
  return { kind: 'text', text: pageTexts.join('\n\n'), pages: pdf.numPages, images, scanned };
}

// ---------------------------------------------------------------------
// テキスト
// ---------------------------------------------------------------------
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch { return new TextDecoder('shift_jis').decode(buf); }
}

/**
 * @param {File} file
 * @param {{asSlides?:boolean, renderImages?:boolean, maxImages?:number}} opts
 * @returns {Promise<{kind:'slides'|'text', text:string, pages?:number, images?:string[], scanned?:boolean}>}
 */
export async function extractFile(file, opts = {}) {
  const name = file.name.toLowerCase();
  const buf = await file.arrayBuffer();
  if (name.endsWith('.pptx')) return extractPptx(buf);
  if (name.endsWith('.docx')) return extractDocx(buf);
  if (name.endsWith('.pdf')) return extractPdf(buf, { asSlides: !!opts.asSlides, renderImages: !!opts.renderImages, maxImages: opts.maxImages ?? 12 });
  if (/\.(txt|md|markdown|text)$/.test(name)) return { kind: 'text', text: decodeText(buf) };
  if (name.endsWith('.ppt') || name.endsWith('.doc')) {
    throw new Error('古い形式（.ppt / .doc）は読めません。PowerPoint や Word で .pptx / .docx か PDF に保存し直してください。');
  }
  throw new Error('対応形式は .pptx / .pdf / .docx / .txt / .md です。');
}

// ---------------------------------------------------------------------
// アプリによる計測（AIに数え直させないための機械的な数値）
// ---------------------------------------------------------------------
export const countChars = s => [...String(s || '').replace(/\s/g, '')].length;

export function parseSlides(text) {
  const parts = String(text || '').split(/^=== スライド\s*\d+\s*===\s*$/m);
  if (parts.length < 2) return null;
  return parts.slice(1).map(block => {
    const lines = block.split('\n');
    let notes = '';
    const body = [];
    let inNotes = false;
    for (const l of lines) {
      if (/^ノート[：:]/.test(l)) { inNotes = true; notes += l.replace(/^ノート[：:]\s*/, '') + '\n'; continue; }
      if (inNotes) { notes += l + '\n'; continue; }
      if (/^図表[：:]/.test(l)) continue;
      body.push(l.replace(/^タイトル[：:]/, ''));
    }
    const fig = (block.match(/^図表[：:](.*)$/m) || [])[1] || '';
    return {
      chars: countChars(body.join('')),
      noteChars: countChars(notes),
      pictures: parseInt((fig.match(/画像(\d+)/) || [])[1] || '0', 10),
      charts: parseInt((fig.match(/グラフ(\d+)/) || [])[1] || '0', 10),
    };
  });
}

/** 症例報告ツール用の計測値。AIへの送信文にも画面にも使う */
export function caseMetrics({ mode, text, minutes, charLimit, imageCount }) {
  const lines = [];
  const facts = [];
  if (mode === 'abstract') {
    const n = countChars(text);
    lines.push(`本文の文字数（空白・改行を除く）：${n.toLocaleString()}字`);
    facts.push({ label: '文字数', value: `${n.toLocaleString()}字` });
    if (charLimit > 0) {
      const diff = charLimit - n;
      const s = diff >= 0 ? `上限まであと${diff}字` : `上限を${-diff}字超過`;
      lines.push(`字数上限：${charLimit}字（${s}）`);
      facts.push({ label: '上限', value: `${charLimit}字`, warn: diff < 0, note: s });
    }
    return { lines, facts };
  }
  const slides = parseSlides(text);
  if (!slides) {
    lines.push('スライド区切り（=== スライド n ===）が見つからないため、枚数は計測できませんでした。');
    lines.push(`全体の文字数：${countChars(text).toLocaleString()}字`);
    facts.push({ label: '文字数', value: `${countChars(text).toLocaleString()}字` });
    return { lines, facts };
  }
  const n = slides.length;
  facts.push({ label: '枚数', value: `${n}枚` });
  lines.push(`スライド枚数：${n}枚`);
  if (minutes > 0) {
    const per = n / minutes;
    lines.push(`発表時間：${minutes}分（1分あたり${per.toFixed(1)}枚。目安は1分1枚前後）`);
    facts.push({ label: '1分あたり', value: `${per.toFixed(1)}枚`, warn: per > 1.5 });
  }
  const per = slides.map(s => s.chars);
  const avg = Math.round(per.reduce((a, b) => a + b, 0) / n);
  const dense = slides.map((s, i) => ({ i: i + 1, c: s.chars })).filter(x => x.c > 150);
  lines.push(`1枚あたりの文字数：平均${avg}字、最大${Math.max(...per)}字`);
  lines.push(`各スライドの文字数：${per.map((c, i) => `${i + 1}:${c}`).join(' ')}`);
  if (dense.length) lines.push(`文字数が150字を超えるスライド：${dense.map(x => `${x.i}枚目(${x.c}字)`).join('、')}`);
  facts.push({ label: '平均文字数/枚', value: `${avg}字`, warn: avg > 120 });
  const pics = slides.reduce((a, s) => a + s.pictures, 0);
  const charts = slides.reduce((a, s) => a + s.charts, 0);
  if (pics || charts) lines.push(`図表の数（PowerPointから取得）：画像${pics}、グラフ${charts}`);
  const noteChars = slides.reduce((a, s) => a + s.noteChars, 0);
  if (noteChars > 0) {
    const speakMin = noteChars / 300;
    lines.push(`発表者ノート（読み原稿）の文字数：${noteChars.toLocaleString()}字（毎分300字で読むと約${speakMin.toFixed(1)}分）`);
    facts.push({ label: '原稿', value: `約${speakMin.toFixed(1)}分`, warn: minutes > 0 && speakMin > minutes * 1.1 });
  } else {
    lines.push('発表者ノート：なし（話し方・時間配分は枚数からの推定のみ）');
  }
  if (imageCount > 0) lines.push(`添付したスライド画像：${imageCount}枚（先頭から順）`);
  else lines.push('スライド画像：添付なし（デザインは文字情報からの推定）');
  return { lines, facts };
}

/** おおまかなトークン数の見積もり（日本語は1文字≒1トークン強として安全側に） */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0, other = 0;
  for (const ch of s) { if (CJK.test(ch)) cjk++; else other++; }
  return Math.ceil(cjk * 1.1 + other / 3.5);
}
