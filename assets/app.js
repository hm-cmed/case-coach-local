// =====================================================================
// app.js — 画面の動き
// 入力・対話はメモリ上だけに置き、ブラウザにも保存しない（設定とプロンプト編集のみ保存）。
// =====================================================================
import { ENGINES, engine, normalizeBase, isLocalBase, ConnectionError, splitThink, probe, localNetworkPermission } from './engines.js';
import { extractFile, caseMetrics, countChars, estimateTokens } from './extract.js';
import { scanPersonalInfo, maskPersonalInfo } from './privacy.js';
import { renderMarkdown } from './markdown.js';
import { parseScores, parseGibbs } from './scores.js';
import * as P from './prompts.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** 小さなDOM生成ヘルパー（CSPのため style 属性は使わない） */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

const fmt = n => (n ?? 0).toLocaleString('ja-JP');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ---------------------------------------------------------------------
// 保存（このブラウザの localStorage。github.io は同じアカウントの他ページと共有されるため名前空間を付ける）
// ---------------------------------------------------------------------
const KEY_SETTINGS = 'casecoach.settings.v1';
const KEY_PROMPTS = 'casecoach.prompts.v1';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境では無視 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
};

const DEFAULT_SETTINGS = {
  engine: 'ollama', base: ENGINES.ollama.defaultBase, model: '',
  temperature: 0.3, numCtx: 16384, think: 'auto', maxImages: 12, openaiVision: false,
};
let settings = { ...DEFAULT_SETTINGS, ...store.get(KEY_SETTINGS, {}) };
let prompts = store.get(KEY_PROMPTS, {});
const saveSettings = () => store.set(KEY_SETTINGS, settings);

const conn = { status: 'unknown', models: [], info: null };

// ---------------------------------------------------------------------
// 作業状態（メモリ上のみ）
// ---------------------------------------------------------------------
function newSession(tool) {
  return { tool, messages: [], system: null, config: null, busy: false, controller: null, dirty: false, lastPromptTokens: null };
}
const sessions = { case: newSession('case'), reflection: newSession('reflection') };
const formImages = { case: [] };
let current = 'case';

// ---------------------------------------------------------------------
// プロンプトの組み立て
// ---------------------------------------------------------------------
function templateFor(tool) {
  const custom = prompts[tool]?.system;
  if (custom && custom.trim()) return custom;
  return tool === 'case' ? P.CASE_SYSTEM_TEMPLATE : P.REFLECTION_SYSTEM_TEMPLATE;
}
const knowledgeFor = tool => prompts[tool]?.knowledge || '';
const fill = (tpl, map) => tpl.replace(/\{([A-Z_]+)\}/g, (m, k) => (k in map ? map[k] : m));

function buildCaseSystem({ mode, hasImages }) {
  const rubric = P.RUBRICS[mode];
  let imagesNote = '';
  if (mode === 'slides') {
    imagesNote = hasImages
      ? '8. スライド画像が添付されている（スライド番号順）。デザイン・図表・可読性は画像を見て評価する。\n'
      : '8. スライド画像は添付されていない。デザイン・図表の項目は文字情報と【アプリ計測値】から推定できる範囲で評価し、その項目の最初に「画像未確認」と書く。\n';
  }
  return fill(templateFor('case'), {
    MODE_LABEL: P.MODE_LABEL[mode],
    RUBRIC: P.rubricText(rubric),
    SCORES_TEMPLATE: P.scoresTemplate(rubric),
    IMAGES_NOTE: imagesNote,
    KNOWLEDGE: P.knowledgeText(knowledgeFor('case')),
  });
}

function buildReflectionSystem({ comps }) {
  return fill(templateFor('reflection'), {
    COMPETENCIES: P.competenciesText(comps),
    KNOWLEDGE: P.knowledgeText(knowledgeFor('reflection')),
  });
}

function readCaseForm() {
  const f = $('#case-form');
  return {
    mode: f.mode.value,
    society: f.society.value.trim(),
    charLimit: parseInt(f.charLimit.value, 10) || 0,
    minutes: parseInt(f.minutes.value, 10) || 0,
    text: f.text.value,
  };
}

function readReflectionForm() {
  const f = $('#reflection-form');
  return {
    stage: f.stage.value,
    kind: f.kind.value,
    comps: $$('#reflection-comps input:checked').map(i => i.value),
    text: f.text.value,
  };
}

function buildCaseUser(form, metrics) {
  return [
    `【依頼】症例報告の${P.MODE_LABEL[form.mode]}を評価してください。`,
    `【学会・セッション】${form.society || '未記入'}`,
    '【アプリ計測値】（アプリが機械的に数えた値です。数え直さずに使ってください）',
    ...metrics.lines.map(l => `- ${l}`),
    '【本文】',
    form.text.trim(),
  ].join('\n');
}

function buildReflectionUser(form) {
  return [
    '【依頼】私の振り返りを読んで、内省を深める手伝いをしてください。',
    `【研修段階】${form.stage || '未記入'}`,
    `【振り返りの種類】${form.kind || '未記入'}`,
    `【関連づけたい資質・能力】${form.comps.length ? form.comps.join('、') : '指定なし'}`,
    `【アプリ計測値】本文の文字数（空白・改行を除く）：${fmt(countChars(form.text))}字`,
    '【振り返り本文】',
    form.text.trim(),
  ].join('\n');
}

// ---------------------------------------------------------------------
// 接続
// ---------------------------------------------------------------------
function visionAllowed() {
  return settings.engine === 'ollama' ? !!conn.info?.vision : !!settings.openaiVision;
}

function updateBoundary() {
  const b = $('#boundary');
  const busy = sessions.case.busy || sessions.reflection.busy;
  b.dataset.state = busy ? 'busy' : conn.status;
  const dot = $('#boundary-status');
  dot.className = 'dot ' + (conn.status === 'ok' ? 'dot-ok' : conn.status === 'error' ? 'dot-error' : 'dot-unknown');
  let host = settings.base;
  try { host = new URL(settings.base).host; } catch { /* noop */ }
  $('#boundary-ai').textContent = settings.engine === 'ollama' ? 'Ollama' : 'AI';
  const label = $('#boundary-label');
  if (conn.status === 'ok') {
    label.textContent = settings.model
      ? `このPCのAIに接続中：${settings.model}（${host}）${busy ? '　応答を生成しています…' : ''}`
      : `このPCのAI（${host}）に接続できました。設定でモデルを選んでください`;
  } else if (conn.status === 'error') {
    label.textContent = `このPCのAI（${host}）に接続できません`;
  } else {
    label.textContent = 'AIにまだ接続していません';
  }
  document.body.classList.toggle('connected', conn.status === 'ok' && !!settings.model);
  $('#boundary-fix').hidden = conn.status !== 'error';
}

function pickDefaultModel(models) {
  const prefer = [/gemma/i, /qwen/i, /llama/i];
  for (const re of prefer) { const m = models.find(x => re.test(x.id) && !/embed/i.test(x.id)); if (m) return m.id; }
  return models.find(x => !/embed/i.test(x.id))?.id || models[0]?.id || '';
}

async function connect({ quiet = false } = {}) {
  const base = normalizeBase(settings.base);
  if (!isLocalBase(base)) {
    conn.status = 'error';
    updateBoundary();
    throw new ConnectionError('このページは、このPCの中（localhost / 127.0.0.1）のAIにだけ接続できます。', 'notlocal');
  }
  try {
    const models = await engine(settings.engine).listModels(base);
    conn.models = models;
    conn.status = 'ok';
    if (!settings.model || !models.some(m => m.id === settings.model)) {
      settings.model = pickDefaultModel(models);
      saveSettings();
    }
    conn.info = settings.model ? await engine(settings.engine).modelInfo(base, settings.model) : null;
    updateBoundary();
    refreshVisionUI();
    return models;
  } catch (e) {
    conn.status = 'error';
    conn.models = [];
    conn.info = null;
    updateBoundary();
    if (!quiet) throw e;
    return [];
  }
}

function connectionHelp(err) {
  const base = normalizeBase(settings.base);
  if (err?.kind === 'notlocal') {
    return { title: '接続先がこのPCの外になっています', body: err.message, steps: ['設定のアドレスを http://localhost:11434（Ollama）や http://localhost:1234（LM Studio）にしてください。'] };
  }
  if (err?.kind === 'notfound') {
    return {
      title: 'AIサーバーは見つかりましたが、要求が通りませんでした',
      body: err.message,
      steps: ['設定の「AIの実行環境」が、実際に使っているもの（Ollama か LM Studio など）と合っているか確認してください。', 'モデル名が正しいか確認してください（設定で選び直す）。'],
    };
  }
  if (err?.kind === 'http') {
    return { title: 'AIサーバーがエラーを返しました', body: err.message, steps: ['モデルがメモリに載りきらない場合があります。小さいモデルを選ぶか、「一度に読める長さ」を減らしてください。', 'Ollama / LM Studio を再起動してから、もう一度送ってください。'] };
  }
  return {
    title: 'このPCのAIに接続できませんでした',
    body: `接続先：${base}`,
    steps: [
      settings.engine === 'ollama' ? 'Ollama が起動しているか確認してください（タスクバー右下にアイコンがあるか）。' : 'LM Studio などでサーバーが起動しているか確認してください。',
      settings.engine === 'ollama'
        ? `この画面からの接続を許可したか確認してください（「準備と使い方」の手順3）。許可したあとは Ollama の再起動が必要です。許可するアドレスは ${location.origin} です。`
        : 'LM Studio の設定で「Enable CORS」がオンになっているか確認してください。',
      'ブラウザのアドレスバー左のアイコン →「サイトの設定」で、ローカルネットワークへのアクセスが「許可」になっているか確認してください。',
      '「原因を調べる」を押すと、どこで止まっているかを順に確かめて直し方を示します。',
    ],
  };
}

// ---------------------------------------------------------------------
// ツール切り替え
// ---------------------------------------------------------------------
function setTool(tool, { updateHash = true } = {}) {
  current = tool;
  document.body.dataset.tool = tool;
  for (const b of $$('.tools [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tool === tool));
  $('#tool-case').hidden = tool !== 'case';
  $('#tool-reflection').hidden = tool !== 'reflection';
  if (updateHash) history.replaceState(null, '', `#${tool}`);
  document.title = (tool === 'case' ? '症例報告・スライド壁打ち' : '事例振り返り') + ' — ケース・コーチ ローカル版';
}

// ---------------------------------------------------------------------
// 入力欄：計測・個人情報チェック
// ---------------------------------------------------------------------
function updateCaseMeta() {
  const form = readCaseForm();
  document.body.dataset.mode = form.mode;
  $('#case-count').textContent = `${fmt(countChars(form.text))}字`;
  const facts = $('#case-facts');
  facts.replaceChildren();
  if (form.text.trim()) {
    const imgs = $('#case-send-images').checked && visionAllowed() ? formImages.case.length : 0;
    const m = caseMetrics({ mode: form.mode, text: form.text, minutes: form.minutes, charLimit: form.charLimit, imageCount: imgs });
    for (const f of m.facts) {
      facts.append(el('li', { class: f.warn ? 'warn' : null, title: f.note || null }, f.label, el('strong', { text: f.value })));
    }
  }
  updateSubmitLabels();
}

function updateReflectionMeta() {
  const t = $('#reflection-text').value;
  $('#reflection-count').textContent = `${fmt(countChars(t))}字`;
}

const piiDismissed = { case: '', reflection: '' };
function renderPii(tool) {
  const ta = $(`#${tool}-text`);
  const box = $(`#${tool}-pii`);
  const text = ta.value;
  if (piiDismissed[tool] && piiDismissed[tool] === text) { box.hidden = true; return; }
  const hits = scanPersonalInfo(text);
  if (!hits.length) { box.hidden = true; box.replaceChildren(); return; }
  const shown = hits.slice(0, 8);
  box.replaceChildren(...[
    el('h3', { text: `個人を特定しうる情報かもしれない箇所：${hits.length}件` }),
    el('ul', {}, shown.map(h => el('li', {}, `${h.label}：`, el('mark', { text: h.match }), el('small', { text: `　${h.hint}` })))),
    hits.length > shown.length ? el('p', { text: `ほか${hits.length - shown.length}件` }) : null,
    el('div', { class: 'actions' },
      el('button', {
        type: 'button', class: 'secondary', text: '検出箇所を●で伏せる',
        onclick: () => { ta.value = maskPersonalInfo(text, hits); ta.dispatchEvent(new Event('input')); },
      }),
      el('button', { type: 'button', class: 'link', text: 'このままでよい', onclick: () => { piiDismissed[tool] = text; box.hidden = true; } }),
    ),
    el('small', { text: 'AIへの送信先はこのPCの中だけです。これは発表やポートフォリオそのものに個人情報が残らないための確認です（自動検出のため、漏れや誤検出があります）。' }),
  ].filter(Boolean));
  box.hidden = false;
}
const renderPiiLater = { case: debounce(() => renderPii('case'), 300), reflection: debounce(() => renderPii('reflection'), 300) };

function updateSubmitLabels() {
  $('#case-submit').textContent = sessions.case.messages.length ? '修正版を再評価する' : '評価してもらう';
  $('#reflection-submit').textContent = sessions.reflection.messages.length ? '書き直した版を読んでもらう' : '読んでもらう';
}

// ---------------------------------------------------------------------
// ファイル読み込み
// ---------------------------------------------------------------------
async function loadFileInto(tool, file) {
  const status = $(`#${tool}-file-status`);
  status.classList.remove('error');
  status.textContent = `${file.name} を読み込んでいます…（このPCの中で処理しています）`;
  try {
    const lower = file.name.toLowerCase();
    let asSlides = false;
    if (tool === 'case') {
      if (lower.endsWith('.pptx')) setCaseMode('slides');
      asSlides = readCaseForm().mode === 'slides';
    }
    const res = await extractFile(file, {
      asSlides,
      renderImages: tool === 'case' && asSlides && lower.endsWith('.pdf') && settings.maxImages > 0,
      maxImages: settings.maxImages,
    });
    const ta = $(`#${tool}-text`);
    ta.value = res.text;
    ta.dispatchEvent(new Event('input'));
    if (tool === 'case') setFormImages(res.images || []);
    const parts = [`${file.name} を読み込みました`];
    if (res.kind === 'slides') parts.push(`スライド${res.pages}枚`);
    else if (res.pages) parts.push(`${res.pages}ページ`);
    if (res.images?.length) parts.push(`画像${res.images.length}枚`);
    let msg = parts.join('・') + '。内容を確かめてから送ってください。';
    if (res.scanned) msg += ' 文字がほとんど取り出せませんでした（画像だけのPDFの可能性）。画像を読めるモデルなら、スライド画像で評価できます。';
    status.textContent = msg;
  } catch (e) {
    status.classList.add('error');
    status.textContent = e.message || 'ファイルを読み込めませんでした。';
  }
}

function setFormImages(images) {
  formImages.case = images;
  const box = $('#case-thumbs');
  const strip = $('#case-thumb-strip');
  strip.replaceChildren(...images.map((src, i) => el('img', { src, alt: `スライド${i + 1}` })));
  box.hidden = !images.length;
  refreshVisionUI();
  updateCaseMeta();
}

function refreshVisionUI() {
  const cb = $('#case-send-images');
  const label = $('#case-thumbs-label');
  if (!formImages.case.length) return;
  if (visionAllowed()) {
    cb.disabled = false;
    label.textContent = `スライド画像（${formImages.case.length}枚）も見てもらう`;
  } else {
    cb.disabled = true;
    cb.checked = false;
    label.textContent = '今のモデルは画像を読めないため、文字だけで評価します';
  }
}

function setCaseMode(mode) {
  const f = $('#case-form');
  for (const r of f.querySelectorAll('input[name=mode]')) r.checked = r.value === mode;
  updateCaseMeta();
}

function wireDrop(tool) {
  const zone = $(`[data-drop="${tool}"]`);
  const input = $(`#${tool}-file`);
  input.addEventListener('change', () => { if (input.files[0]) loadFileInto(tool, input.files[0]); input.value = ''; });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFileInto(tool, f);
  });
}

// ---------------------------------------------------------------------
// 対話の表示
// ---------------------------------------------------------------------
function rubricFor(session) { return P.RUBRICS[session.config?.mode || 'abstract']; }

function previousScores(session, idx) {
  for (let i = idx - 1; i >= 0; i--) { const s = session.messages[i].meta?.scores; if (s) return s; }
  return null;
}

function scoreSheet(scores, prev) {
  const verdict = el('div', { class: 'verdict' },
    el('div', { class: 'stamp', text: scores.rank.label, 'aria-label': `ランク${scores.rank.label}` }),
    el('div', { class: 'total' }, String(scores.total), el('small', { text: ` / ${scores.maxTotal}` })),
  );
  if (prev) {
    const d = scores.total - prev.total;
    verdict.append(el('div', { class: `delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`, text: `前回から ${d > 0 ? '+' : ''}${d}` }));
  }
  verdict.append(el('div', { class: 'rank-note', text: scores.rank.note }));

  const items = el('ol', { class: 'items' }, scores.items.map((it, k) => {
    const fillEl = el('i');
    const pct = it.score == null ? 0 : (it.score / it.max) * 100;
    fillEl.style.width = `${pct}%`;
    const prevIt = prev?.items?.[k];
    const diff = prevIt && it.score != null && prevIt.score != null ? it.score - prevIt.score : 0;
    return el('li', {},
      el('span', { text: it.name }),
      el('span', { class: 'bar' }, fillEl),
      el('span', { class: 'pts' }, el('b', { text: it.score == null ? '—' : String(it.score) }), `/${it.max}`, diff ? el('small', { text: ` ${diff > 0 ? '+' : ''}${diff}` }) : null),
    );
  }));

  const notes = [];
  notes.push('合計とランクは、AIの各項目の点からこの画面が計算しています。');
  if (scores.statedTotal != null && scores.statedTotal !== scores.total) notes.push(`AIが本文で書いた合計（${scores.statedTotal}点）とは異なります。`);
  if (!scores.complete) notes.push('一部の項目の点が読み取れませんでした（—の項目は0点として合計）。');
  return el('div', { class: 'sheet' }, verdict, items, el('p', { class: 'sheet-note', text: notes.join(' ') }));
}

function gibbsCard(g) {
  const word = { 2: '十分', 1: '一部', 0: 'なし' };
  return el('div', { class: 'gibbs' },
    el('div', { class: 'gibbs-track' }, P.GIBBS_STAGES.map(stage => {
      const lv = g.stages[stage];
      return el('div', { class: 'gibbs-step', dataset: { lv: lv == null ? '' : String(lv) } },
        el('div', { class: 'seg-bar', 'aria-hidden': 'true' }),
        el('b', { text: `${stage}：${lv == null ? '—' : word[lv]}` }),
        el('span', { text: P.GIBBS_HINT[stage] }),
      );
    })),
    g.depth ? el('p', { class: 'gibbs-depth' }, '振り返りの深さ：', el('b', { text: g.depth })) : null,
    el('p', { class: 'gibbs-legend', text: 'Gibbs のリフレクティブ・サイクルと Hatton & Smith の4水準による、AIの見立てです。' }),
  );
}

function fenceRenderer(msg, streaming) {
  return (lang, code, closed) => {
    if (lang !== 'scores' && lang !== 'gibbs') return null;
    if (streaming || !closed) return '<p class="pending">（集計しています…）</p>';
    if (lang === 'scores' && msg.meta?.scores) return '<div class="card-slot" data-kind="scores"></div>';
    if (lang === 'gibbs' && msg.meta?.gibbs) return '<div class="card-slot" data-kind="gibbs"></div>';
    return null;
  };
}

/** 表示用：点数表を出すときは、AIが自分で足し算した「総合○点・ランク○」を消す（表の値と食い違うことがあるため） */
function displayText(msg) {
  if (!msg.meta?.scores) return msg.content;
  return msg.content.replace(/総合\s*[:：]?\s*\d{1,3}\s*点[・、,，\s]*(?:ランク\s*[:：]?\s*[A-DＡ-Ｄ])?[。．]?/, '');
}

function placeCard(body, kind, node) {
  const slot = body.querySelector(`.card-slot[data-kind="${kind}"]`);
  if (slot) slot.replaceWith(node); else body.append(node);
}

function renderAssistant(tool, msg, idx, isLast) {
  const s = sessions[tool];
  const streaming = s.busy && isLast;
  const li = el('li', { class: `msg msg-ai${streaming ? ' streaming' : ''}` });
  const who = el('p', { class: 'who' }, el('span', { text: `AI（${msg.meta?.model || ''}）` }));
  const m = msg.meta || {};
  if (m.promptTokens != null) who.append(el('span', { text: `読んだ量 ${fmt(m.promptTokens)}・書いた量 ${fmt(m.outputTokens)} トークン` }));
  if (m.seconds) who.append(el('span', { text: `${m.seconds.toFixed(0)}秒` }));
  li.append(who);

  const think = el('details', { class: 'thinking' }, el('summary', { text: 'AIが考えた過程' }), el('pre', { text: m.thinking || '' }));
  think.hidden = !m.thinking;
  li.append(think);

  const body = el('div', { class: 'body' });
  body.innerHTML = renderMarkdown(displayText(msg), { fence: fenceRenderer(msg, streaming) });
  li.append(body);

  if (!streaming) {
    if (m.scores) placeCard(body, 'scores', scoreSheet(m.scores, previousScores(s, idx)));
    if (m.gibbs) placeCard(body, 'gibbs', gibbsCard(m.gibbs));
    const notices = [];
    if (m.aborted) notices.push('途中で止めました。');
    if (m.truncated) notices.push('長さの上限に達して途中で切れました。「続きを書いてください」と送るか、設定で「一度に読める長さ」を増やしてください。');
    if (!msg.content.trim() && !m.aborted) notices.push('AIから本文が返ってきませんでした。「再生成」を押すか、別のモデルを試してください。');
    if (tool === 'case' && !m.scores && msg.content.trim() && m.expectScores && !m.aborted) notices.push('点数の表を読み取れませんでした（書式が崩れた可能性）。「再生成」を押すか、大きめのモデルを試してください。');
    for (const n of notices) li.append(el('p', { class: 'notice', text: n }));

    const row = el('div', { class: 'tools-row' },
      el('button', { type: 'button', class: 'link', text: 'コピー', onclick: e => copyText(msg.content, e.currentTarget) }),
    );
    if (isLast) row.append(el('button', { type: 'button', class: 'link', text: '再生成', onclick: () => regenerate(tool) }));
    li.append(row);
  }
  li._body = body;
  li._think = think;
  return li;
}

function renderUser(msg) {
  const li = el('li', { class: 'msg msg-user' }, el('div', { class: 'bubble', text: msg.display || msg.content }));
  if (msg.display && msg.display !== msg.content) {
    li.append(el('details', {}, el('summary', { text: '送った内容を見る' }), el('pre', { text: msg.content })));
  }
  if (msg.images?.length) {
    li.append(el('div', { class: 'mini-thumbs' }, msg.images.map((src, i) => el('img', { src, alt: `添付画像${i + 1}` }))));
  }
  return li;
}

function renderError(tool, item) {
  const node = $('#tpl-error').content.firstElementChild.cloneNode(true);
  $('.err-title', node).textContent = item.title;
  $('.err-body', node).textContent = item.body;
  $('.err-steps', node).replaceChildren(...item.steps.map(t => el('li', { text: t })));
  const retry = el('button', { type: 'button', class: 'primary', text: 'もう一度送る', onclick: () => retryLast(tool) });
  $('p:last-child', node).prepend(retry, ' ');
  return node;
}

function renderLog(tool) {
  const s = sessions[tool];
  const log = $(`#${tool}-log`);
  const nodes = s.messages.map((m, i) => {
    const isLast = i === s.messages.length - 1;
    if (m.role === 'user') return renderUser(m);
    if (m.role === 'error') return renderError(tool, m);
    return renderAssistant(tool, m, i, isLast);
  });
  log.replaceChildren(...nodes);
  const has = s.messages.length > 0;
  $(`#${tool}-empty`).hidden = has;
  $(`#${tool}-dock`).hidden = !has;
  updateBusyUI(tool);
  updateMeter(tool);
  updateSubmitLabels();
}

function updateBusyUI(tool) {
  const s = sessions[tool];
  const dock = $(`#${tool}-dock`);
  $('.stop', dock).hidden = !s.busy;
  $('.composer .primary', dock).hidden = s.busy;
  for (const b of $$('.quick button', dock)) b.disabled = s.busy;
  $(`#${tool}-submit`).disabled = s.busy;
  updateBoundary();
}

function apiMessages(session) {
  return [
    { role: 'system', content: session.system },
    ...session.messages
      .filter(m => (m.role === 'user' || m.role === 'assistant') && !(m.role === 'assistant' && !m.content.trim()))
      .map(m => ({ role: m.role, content: m.content, images: m.images })),
  ];
}

function updateMeter(tool) {
  const s = sessions[tool];
  const meter = $(`#${tool}-meter`);
  if (!s.messages.length || !s.system) { meter.textContent = ''; return; }
  const msgs = apiMessages(s);
  const imgs = msgs.reduce((a, m) => a + (m.images?.length || 0), 0);
  const est = msgs.reduce((a, m) => a + estimateTokens(m.content), 0) + imgs * 400;
  const used = Math.max(est, s.lastPromptTokens || 0);
  if (settings.engine === 'ollama') {
    const limit = settings.numCtx;
    meter.textContent = `会話の長さ：約${fmt(used)} / ${fmt(limit)} トークン`;
    meter.classList.toggle('warn', used > limit * 0.85);
    if (used > limit * 0.85) meter.textContent += '（上限に近いため、古い部分をAIが忘れることがあります）';
  } else {
    meter.textContent = `会話の長さ：約${fmt(used)} トークン`;
    meter.classList.remove('warn');
  }
}

// ---------------------------------------------------------------------
// 送信と生成
// ---------------------------------------------------------------------
function ensureReady() {
  if (!isLocalBase(settings.base)) { openSettings('このページは、このPCの中のAIにだけ接続できます。アドレスを確認してください。'); return false; }
  if (!settings.model) { openSettings('まず「接続を確かめる」を押して、使うモデルを選んでください。'); return false; }
  return true;
}

function pushUser(tool, msg) {
  const s = sessions[tool];
  // 直前がエラーなら取り除く（もう一度送ったものとして扱う）
  while (s.messages.length && s.messages[s.messages.length - 1].role === 'error') s.messages.pop();
  s.messages.push({ role: 'user', ...msg });
  s.dirty = true;
}

async function runAssistant(tool) {
  const s = sessions[tool];
  if (s.busy) return;
  const msg = { role: 'assistant', content: '', meta: { model: settings.model, thinking: '', expectScores: tool === 'case' } };
  s.messages.push(msg);
  s.busy = true;
  s.controller = new AbortController();
  renderLog(tool);
  scrollToEnd(tool, true);

  const li = $(`#${tool}-log`).lastElementChild;
  let raw = '';
  let thinking = '';
  let frame = 0;
  const paint = () => {
    frame = 0;
    const split = splitThink(raw);
    li._body.innerHTML = renderMarkdown(split.text, { fence: fenceRenderer(msg, true) });
    const t = thinking + split.thinking;
    if (t) { li._think.hidden = false; li._think.querySelector('pre').textContent = t; }
    scrollToEnd(tool);
  };

  try {
    const stream = engine(settings.engine).chat({
      base: normalizeBase(settings.base),
      model: settings.model,
      messages: apiMessages(s),
      temperature: settings.temperature,
      numCtx: settings.numCtx,
      thinkOff: settings.think === 'off',
      info: conn.info,
      signal: s.controller.signal,
    });
    for await (const ev of stream) {
      if (ev.type === 'text') raw += ev.text;
      else if (ev.type === 'thinking') thinking += ev.text;
      else if (ev.type === 'done') {
        Object.assign(msg.meta, { promptTokens: ev.promptTokens, outputTokens: ev.outputTokens, seconds: ev.seconds, truncated: ev.truncated });
        if (ev.promptTokens) s.lastPromptTokens = ev.promptTokens + (ev.outputTokens || 0);
      }
      if (!frame) frame = requestAnimationFrame(paint);
    }
    if (conn.status !== 'ok') { conn.status = 'ok'; updateBoundary(); }
  } catch (e) {
    if (e?.name === 'AbortError') {
      msg.meta.aborted = true;
    } else {
      s.messages.pop(); // 空の返答を取り除き、エラー表示に置き換える
      const help = connectionHelp(e);
      if (e?.kind === 'network') { conn.status = 'error'; }
      s.messages.push({ role: 'error', ...help });
      raw = null;
    }
  } finally {
    if (frame) cancelAnimationFrame(frame);
    if (raw !== null) {
      const split = splitThink(raw);
      msg.content = split.text;
      msg.meta.thinking = (thinking + split.thinking).trim();
      if (tool === 'case') msg.meta.scores = parseScores(msg.content, rubricFor(s));
      else msg.meta.gibbs = parseGibbs(msg.content);
    }
    s.busy = false;
    s.controller = null;
    s.dirty = true;
    renderLog(tool);
    scrollToEnd(tool);
  }
}

function regenerate(tool) {
  const s = sessions[tool];
  if (s.busy) return;
  const last = s.messages[s.messages.length - 1];
  if (last?.role === 'assistant') s.messages.pop();
  runAssistant(tool);
}

function retryLast(tool) {
  const s = sessions[tool];
  while (s.messages.length && s.messages[s.messages.length - 1].role === 'error') s.messages.pop();
  if (!s.messages.length) { renderLog(tool); return; }
  if (!ensureReady()) return;
  runAssistant(tool);
}

function scrollToEnd(tool, force = false) {
  const log = $(`#${tool}-log`);
  const last = log.lastElementChild;
  if (!last) return;
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 260;
  if (force || nearBottom) last.scrollIntoView({ block: force ? 'start' : 'end', behavior: 'auto' });
}

function submitCase(e) {
  e?.preventDefault();
  const s = sessions.case;
  if (s.busy) return;
  const form = readCaseForm();
  const ta = $('#case-text');
  if (!form.text.trim() && !formImages.case.length) { ta.focus(); ta.placeholder = 'ここに本文を入れてから送ってください。'; return; }
  if (!ensureReady()) return;
  if (s.messages.length && s.config?.mode !== form.mode) {
    if (!confirm('「見てもらうもの」が変わりました。今の対話を終えて、新しい評価として始めますか？')) return;
    sessions.case = newSession('case');
  }
  const session = sessions.case;
  const images = form.mode === 'slides' && $('#case-send-images').checked && visionAllowed() ? formImages.case : [];
  if (!session.system) {
    session.config = { mode: form.mode, hasImages: images.length > 0 };
    session.system = buildCaseSystem(session.config);
  }
  const metrics = caseMetrics({ mode: form.mode, text: form.text, minutes: form.minutes, charLimit: form.charLimit, imageCount: images.length });
  const isRevision = session.messages.some(m => m.role === 'assistant');
  const label = P.MODE_LABEL[form.mode];
  const summary = form.mode === 'abstract' ? `${fmt(countChars(form.text))}字` : (metrics.facts.find(f => f.label === '枚数')?.value || `${fmt(countChars(form.text))}字`);
  pushUser('case', {
    content: (isRevision ? P.REEVALUATE_PREFIX : '') + buildCaseUser(form, metrics),
    display: `${isRevision ? '修正した' : ''}${label}を${isRevision ? '再評価' : '評価'}してください（${summary}${images.length ? `・画像${images.length}枚` : ''}）`,
    images,
  });
  runAssistant('case');
}

function submitReflection(e) {
  e?.preventDefault();
  const s = sessions.reflection;
  if (s.busy) return;
  const form = readReflectionForm();
  const ta = $('#reflection-text');
  if (!form.text.trim()) { ta.focus(); ta.placeholder = 'ここに振り返りを入れてから送ってください。'; return; }
  if (!ensureReady()) return;
  if (!s.system) {
    s.config = { comps: form.comps };
    s.system = buildReflectionSystem(s.config);
  }
  const isRevision = s.messages.some(m => m.role === 'assistant');
  pushUser('reflection', {
    content: (isRevision ? P.REFLECTION_REVISED_PREFIX : '') + buildReflectionUser(form),
    display: `${isRevision ? '書き直した' : ''}振り返りを読んでください（${fmt(countChars(form.text))}字）`,
  });
  runAssistant('reflection');
}

function sendFollowUp(tool, text, display) {
  const s = sessions[tool];
  if (s.busy || !text.trim()) return;
  if (!ensureReady()) return;
  pushUser(tool, { content: text.trim(), display: display || text.trim() });
  runAssistant(tool);
}

function wireDialogue(tool) {
  const dock = $(`#${tool}-dock`);
  const composer = $('.composer', dock);
  const ta = $('textarea', composer);
  composer.addEventListener('submit', e => { e.preventDefault(); const t = ta.value; ta.value = ''; sendFollowUp(tool, t); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); composer.requestSubmit(); } });
  $('.stop', dock).addEventListener('click', () => sessions[tool].controller?.abort());
  $(`#${tool}-quick`).replaceChildren(...P.QUICK_ACTIONS[tool].map(q =>
    el('button', { type: 'button', text: q.label, onclick: () => sendFollowUp(tool, q.text, q.label) })));
  for (const b of $$('[data-act]', dock)) {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'export-md') exportMarkdown(tool);
      if (act === 'save-json') saveSession(tool);
      if (act === 'reset') resetSession(tool);
    });
  }
}

function resetSession(tool) {
  const s = sessions[tool];
  if (s.busy) s.controller?.abort();
  if (s.dirty && s.messages.length && !confirm('今の対話は消えます（書き出していない場合は残りません）。新しく始めますか？')) return;
  sessions[tool] = newSession(tool);
  renderLog(tool);
}

// ---------------------------------------------------------------------
// 書き出し・保存（すべてこのPCへのダウンロード）
// ---------------------------------------------------------------------
function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return { file: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`, human: d.toLocaleString('ja-JP') };
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportMarkdown(tool) {
  const s = sessions[tool];
  if (!s.messages.length) return;
  const t = stamp();
  const title = tool === 'case' ? '症例報告・スライド壁打ち 記録' : '事例振り返り 記録';
  const out = [`# ${title}`, '', `- 日時：${t.human}`, `- AI：${settings.model}（${ENGINES[settings.engine].label}・このPC内で実行）`];
  if (tool === 'case' && s.config) out.push(`- 種別：${P.MODE_LABEL[s.config.mode]}`);
  const scored = s.messages.filter(m => m.meta?.scores);
  if (scored.length) {
    out.push('', '## 点数の推移', '', '| 回 | 総合 | ランク |', '|---|---|---|');
    scored.forEach((m, i) => out.push(`| ${i + 1} | ${m.meta.scores.total}/${m.meta.scores.maxTotal} | ${m.meta.scores.rank.label} |`));
    const last = scored[scored.length - 1].meta.scores;
    out.push('', '最新の項目別：', '', ...last.items.map(it => `- ${it.name}：${it.score ?? '—'}/${it.max}`));
  }
  out.push('', '## 対話', '');
  let n = 0;
  for (const m of s.messages) {
    if (m.role === 'user') { n++; out.push(`### あなた（${n}）`, '', m.content, ''); }
    else if (m.role === 'assistant') out.push('### AI', '', m.content, '');
  }
  out.push('---', 'AIの評価は練習用の目安です。正式な査読や指導医の評価・臨床判断に代わるものではありません。');
  download(`${tool === 'case' ? 'case-review' : 'reflection'}_${t.file}.md`, out.join('\n'), 'text/markdown;charset=utf-8');
  s.dirty = false;
}

function saveSession(tool) {
  const s = sessions[tool];
  const t = stamp();
  const form = tool === 'case' ? { ...readCaseForm(), images: formImages.case } : readReflectionForm();
  const data = {
    app: 'case-coach-local', version: 1, savedAt: new Date().toISOString(), tool,
    form,
    session: { messages: s.messages.filter(m => m.role !== 'error'), system: s.system, config: s.config },
  };
  download(`${tool === 'case' ? 'case-review' : 'reflection'}_${t.file}.json`, JSON.stringify(data), 'application/json');
  s.dirty = false;
}

async function openSessionFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'case-coach-local' || !['case', 'reflection'].includes(data.tool)) throw new Error('このツールで保存したファイルではありません。');
    const tool = data.tool;
    if (sessions[tool].busy) sessions[tool].controller?.abort();
    if (sessions[tool].dirty && sessions[tool].messages.length && !confirm('今の対話を、読み込んだ作業で置き換えますか？')) return;
    const s = newSession(tool);
    s.messages = Array.isArray(data.session?.messages) ? data.session.messages : [];
    s.system = data.session?.system || null;
    s.config = data.session?.config || null;
    sessions[tool] = s;
    const f = data.form || {};
    if (tool === 'case') {
      const form = $('#case-form');
      setCaseMode(f.mode === 'slides' ? 'slides' : 'abstract');
      form.society.value = f.society || '';
      form.charLimit.value = f.charLimit || '';
      form.minutes.value = f.minutes || 7;
      form.text.value = f.text || '';
      setFormImages(Array.isArray(f.images) ? f.images.filter(x => typeof x === 'string' && x.startsWith('data:image/')) : []);
      updateCaseMeta();
    } else {
      const form = $('#reflection-form');
      form.stage.value = f.stage || '';
      form.kind.value = f.kind || '';
      for (const cb of $$('#reflection-comps input')) cb.checked = (f.comps || []).includes(cb.value);
      form.text.value = f.text || '';
      updateReflectionMeta();
    }
    renderPii(tool);
    setTool(tool);
    renderLog(tool);
  } catch (e) {
    alert(e.message || 'ファイルを開けませんでした。');
  }
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) { const o = btn.textContent; btn.textContent = 'コピーしました'; setTimeout(() => { btn.textContent = o; }, 1500); }
  } catch { /* クリップボードが使えない環境 */ }
}

// ---------------------------------------------------------------------
// 設定ダイアログ
// ---------------------------------------------------------------------
const dlgSettings = $('#settings');

function wireTabs(dialog) {
  for (const tab of $$('.dlg-tabs [data-pane]', dialog)) {
    tab.addEventListener('click', () => {
      const group = tab.closest('.dlg-tabs');
      for (const t of $$('[data-pane]', group)) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        $(`#${t.dataset.pane}`).hidden = !on;
      }
    });
  }
}

function fillModelSelect() {
  const sel = $('#set-model');
  if (!conn.models.length) {
    sel.replaceChildren(el('option', { value: settings.model || '', text: settings.model || '（接続すると一覧が出ます）' }));
    return;
  }
  sel.replaceChildren(...conn.models.map(m => el('option', { value: m.id, text: m.detail ? `${m.id}（${m.detail}）` : m.id })));
  sel.value = settings.model;
}

function showModelInfo() {
  const p = $('#set-model-info');
  if (settings.engine !== 'ollama' || !conn.info?.known) { p.textContent = ''; return; }
  const bits = [];
  bits.push(conn.info.vision ? '画像を読めます（PDFのスライド画像も評価に使えます）' : '画像は読めません（文字だけで評価します）');
  if (conn.info.contextLength) bits.push(`このモデルが扱える長さの上限：${fmt(conn.info.contextLength)} トークン`);
  if (conn.info.thinking) bits.push('考える過程（推論）を出すモデルです');
  p.textContent = bits.join('　');
}

function showConnResult(kind, content) {
  const box = $('#set-result');
  box.className = `conn-result ${kind}`;
  box.replaceChildren(...[content].flat());
}

// ---------------------------------------------------------------------
// 接続の診断：どの段階で止まっているかを順に確かめ、その場で直し方を示す
// ---------------------------------------------------------------------
const OS = /Windows/i.test(navigator.userAgent) ? 'win' : /Mac/i.test(navigator.userAgent) ? 'mac' : 'other';

function cmdBox(text) {
  const btn = el('button', { type: 'button', class: 'copy', text: 'コピー' });
  btn.addEventListener('click', () => copyText(text, btn));
  return el('div', { class: 'cmd' }, el('code', { text }), btn);
}

function originsCommand() {
  return OS === 'mac'
    ? `launchctl setenv OLLAMA_ORIGINS "${location.origin}"`
    : `[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "${location.origin}", "User")`;
}

function originsCheckCommand(base) {
  return `curl.exe -i -H "Origin: ${location.origin}" ${base}/api/tags`;
}

function fixNotAllowed(base) {
  if (settings.engine !== 'ollama') {
    return [
      el('p', { text: 'LM Studio などのサーバーは動いていますが、ブラウザからの接続を受け付けていません。' }),
      el('ol', {},
        el('li', { text: 'LM Studio の Developer（開発者）画面で、Server Settings の「Enable CORS」をオンにする。' }),
        el('li', { text: 'サーバーを Stop → Start で起動し直す。' }),
        el('li', { text: 'この画面で「もう一度確かめる」を押す。' }),
      ),
    ];
  }
  const steps = [
    el('li', {}, OS === 'mac' ? 'ターミナルに次を貼り付けて Enter を押す。' : 'PowerShell に次を貼り付けて Enter を押す（何も表示されなければ成功）。', cmdBox(originsCommand())),
    el('li', { text: OS === 'mac'
      ? 'メニューバーの Ollama アイコン →「Quit Ollama」で終了し、アプリケーションから Ollama を起動し直す。'
      : 'タスクバー右下（「^」の中）の Ollama アイコンを右クリック →「Quit Ollama」で終了し、スタートメニューから Ollama を起動し直す。' }),
    el('li', { text: 'この画面で「もう一度確かめる」を押す。' }),
  ];
  const parts = [
    el('p', {}, 'Ollama は動いていますが、このサイト（', el('code', { text: location.origin }), '）からの接続を許可していません。Ollama は最初、ブラウザで開いたサイトからの接続を断る設定になっているためです。次の3つで直ります。'),
    el('ol', {}, steps),
  ];
  if (OS === 'win') {
    parts.push(el('details', { class: 'diag-more' },
      el('summary', { text: 'それでも直らないとき' }),
      el('p', { text: 'まず、設定が保存されているかを確かめます。PowerShell で次を実行し、このサイトのアドレスが表示されればOKです（何も表示されなければ、手順1をもう一度）。' }),
      cmdBox('[Environment]::GetEnvironmentVariable("OLLAMA_ORIGINS", "User")'),
      el('p', { text: '次に、Ollama が設定を読み込んでいるかを確かめます。結果の1行目が「HTTP/1.1 200 OK」なら許可済み、「HTTP/1.1 403 Forbidden」なら Ollama の再起動がまだです。' }),
      cmdBox(originsCheckCommand(base)),
      el('p', { text: 'PowerShell の行頭が「>>」のまま止まったら、Ctrl + C で取り消して、コピーし直してください。' }),
      el('p', {}, el('strong', { text: '200 OK なのにここが ✕ のとき：' }), 'Ollama 側の設定は済んでいて、ブラウザ側で止まっています。Chrome をいったん完全に閉じて開き直し、それでもだめなら、シークレットウィンドウ（Ctrl + Shift + N）でこのページを開いて試してください。シークレットで動く場合は、拡張機能（特に Ollama と連携する拡張機能）が通信を書き換えています。その拡張機能をオフにしてください。'),
      el('p', { text: '403 のままなら、Ollama が完全に終わっていない可能性があります。PCを再起動してから、もう一度確かめてください。' }),
    ));
  }
  return parts;
}

function fixNotRunning(base) {
  const isOllama = settings.engine === 'ollama';
  const port = (() => { try { return new URL(base).port; } catch { return ''; } })();
  return [
    el('p', { text: `${base} に応答がありません。` }),
    el('ol', {},
      el('li', { text: isOllama
        ? (OS === 'win' ? 'Ollama が起動しているか確かめる。タスクバー右下（「^」の中）に Ollama のアイコンがなければ、スタートメニューから Ollama を起動する。' : 'Ollama が起動しているか確かめる（メニューバーのアイコン）。')
        : 'LM Studio などでサーバーが起動しているか確かめる（Developer 画面で Start）。' }),
      el('li', { text: isOllama
        ? `アドレスは http://localhost:11434 のままにする（11434 は Ollama の標準の番号）。${port && port !== '11434' ? `いまは ${port} 番になっています。Ollama の設定（OLLAMA_HOST）で番号を変えていなければ 11434 に戻してください。` : ''}`
        : 'アドレスの番号を、LM Studio の画面に表示されているサーバーの番号（標準は 1234）に合わせる。' }),
      el('li', { text: 'Ollama などは確かに動いているのにここで止まる場合は、ブラウザが接続を止めています。アドレスバー左のアイコン →「サイトの設定」で「ローカル ネットワーク アクセス」（または「ローカル ネットワーク上のデバイス」）を「許可」にし、ページを再読み込みしてください。' }),
    ),
  ];
}

function fixBrowserBlocked() {
  return [
    el('p', { text: 'ブラウザが、このサイトからPC内のAIへの接続を止めています（以前に「ブロック」を選んだ場合など）。' }),
    el('ol', {},
      el('li', { text: 'アドレスバー左のアイコン（鍵や設定のマーク）をクリック →「サイトの設定」を開く。' }),
      el('li', { text: '「ローカル ネットワーク アクセス」（または「ローカル ネットワーク上のデバイス」）を「許可」にする。' }),
      el('li', { text: 'このページを再読み込みして、もう一度「接続を確かめる」を押す。' }),
    ),
  ];
}

function renderDiagnosis(steps, fix, okMessage) {
  const mark = { ok: '✓', ng: '✕', wait: '…', skip: '－' };
  const list = el('ol', { class: 'diag' }, steps.map(st =>
    el('li', { class: `diag-${st.state}` },
      el('span', { class: 'diag-mark', 'aria-hidden': 'true', text: mark[st.state] }),
      el('span', {}, st.label, st.note ? el('small', { text: `　${st.note}` }) : null),
    )));
  const parts = [list];
  if (fix) parts.push(el('div', { class: 'diag-fix' }, fix, el('p', {}, el('button', { type: 'button', class: 'primary', text: 'もう一度確かめる', onclick: diagnose }))));
  if (okMessage) parts.push(el('p', { class: 'diag-ok', text: okMessage }));
  const anyNg = steps.some(s => s.state === 'ng');
  showConnResult(anyNg ? 'err' : steps.every(s => s.state === 'ok') ? 'ok' : '', parts);
}

let diagnosing = false;
async function diagnose() {
  if (diagnosing) return;
  diagnosing = true;
  try {
    const d = dlgSettings;
    settings.engine = $('input[name=engine]:checked', d).value;
    settings.base = normalizeBase($('#set-base').value || ENGINES[settings.engine].defaultBase);
    $('#set-base').value = settings.base;
    saveSettings();
    const base = settings.base;
    const name = settings.engine === 'ollama' ? 'Ollama' : 'LM Studio など';
    const steps = [
      { label: `${name} がこのPCで動いている`, state: 'wait' },
      { label: `このサイトからの接続を ${name} が許可している`, state: 'wait' },
      { label: '使えるモデルが入っている', state: 'wait' },
    ];
    renderDiagnosis(steps);

    if (!isLocalBase(base)) {
      steps.forEach(s => { s.state = 'skip'; });
      steps[0].state = 'ng';
      renderDiagnosis(steps, [el('p', { text: 'このページは、このPCの中（localhost / 127.0.0.1）のAIにだけ接続できます。' }),
        el('p', { text: `アドレスを ${ENGINES[settings.engine].defaultBase} にしてください。` })]);
      return;
    }

    let models = null, err = null;
    try { models = await connect(); } catch (e) { err = e; }

    if (models) {
      steps[0].state = 'ok';
      steps[1].state = 'ok';
      fillModelSelect();
      showModelInfo();
      if (!models.length) {
        steps[2].state = 'ng';
        renderDiagnosis(steps, [el('p', { text: 'モデルがまだ入っていません。' }),
          settings.engine === 'ollama' ? cmdBox('ollama pull gemma3:12b') : el('p', { text: 'LM Studio でモデルをダウンロードして読み込んでください。' })]);
      } else {
        steps[2].state = 'ok';
        steps[2].note = `${models.length}件`;
        renderDiagnosis(steps, null, `接続できました。下の「使うモデル」を確かめて、設定を閉じてください。`);
      }
      return;
    }

    if (err?.kind === 'notfound' || err?.kind === 'http') {
      steps[0].state = 'ok';
      steps[1].state = 'ok';
      steps[2].state = 'ng';
      const h = connectionHelp(err);
      renderDiagnosis(steps, [el('p', { text: h.body }), el('ol', {}, h.steps.map(t => el('li', { text: t })))]);
      return;
    }

    const reachable = await probe(base);
    if (reachable) {
      steps[0].state = 'ok';
      steps[1].state = 'ng';
      steps[2].state = 'skip';
      renderDiagnosis(steps, fixNotAllowed(base));
      return;
    }
    const perm = await localNetworkPermission();
    steps[1].state = 'skip';
    steps[2].state = 'skip';
    if (perm === 'denied') {
      steps[0].state = 'skip';
      steps[0].note = 'ブラウザが接続を止めているため確認できません';
      renderDiagnosis(steps, fixBrowserBlocked());
    } else {
      steps[0].state = 'ng';
      renderDiagnosis(steps, fixNotRunning(base));
    }
  } finally {
    diagnosing = false;
    fillModelSelect();
    renderLog('case');
    renderLog('reflection');
  }
}

function updateBaseHint() {
  const hint = $('#set-base-hint');
  if (!hint) return;
  hint.textContent = settings.engine === 'ollama'
    ? 'Ollama は通常このまま（http://localhost:11434）で大丈夫です。11434 は Ollama の標準の番号で、Ollama の設定（OLLAMA_HOST）で変えていない限り変更不要です。'
    : 'LM Studio の標準は http://localhost:1234 です。LM Studio の Developer 画面に表示される番号に合わせてください。';
}

function openSettings(message) {
  const d = dlgSettings;
  d.dataset.engine = settings.engine;
  for (const r of $$('input[name=engine]', d)) r.checked = r.value === settings.engine;
  $('#set-base').value = settings.base;
  $('#set-temp').value = settings.temperature;
  $('#set-temp-val').textContent = settings.temperature.toFixed(1);
  $('#set-ctx').value = String(settings.numCtx);
  $('#set-think').value = settings.think;
  $('#set-maximg').value = String(settings.maxImages);
  $('#set-vision').checked = !!settings.openaiVision;
  fillModelSelect();
  showModelInfo();
  updateBaseHint();
  if (message) showConnResult('err', el('strong', { text: message }));
  else if (conn.status === 'ok') showConnResult('ok', `接続中：${settings.model || 'モデル未選択'}`);
  else $('#set-result').replaceChildren();
  loadPromptPane();
  if (!d.open) d.showModal();
}

function wireSettings() {
  const d = dlgSettings;
  wireTabs(d);
  for (const r of $$('input[name=engine]', d)) {
    r.addEventListener('change', () => {
      const prev = settings.engine;
      settings.engine = r.value;
      d.dataset.engine = r.value;
      const cur = normalizeBase($('#set-base').value);
      if (!cur || cur === ENGINES[prev].defaultBase) $('#set-base').value = ENGINES[r.value].defaultBase;
      conn.models = []; conn.status = 'unknown'; conn.info = null;
      settings.model = '';
      saveSettings();
      fillModelSelect();
      showModelInfo();
      updateBaseHint();
      $('#set-result').replaceChildren();
      updateBoundary();
    });
  }
  $('#set-test').addEventListener('click', diagnose);
  $('#set-base').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); diagnose(); } });
  $('#set-model').addEventListener('change', async e => {
    settings.model = e.target.value;
    saveSettings();
    conn.info = await engine(settings.engine).modelInfo(normalizeBase(settings.base), settings.model);
    showModelInfo();
    refreshVisionUI();
    updateBoundary();
    updateCaseMeta();
  });
  $('#set-temp').addEventListener('input', e => { settings.temperature = parseFloat(e.target.value); $('#set-temp-val').textContent = settings.temperature.toFixed(1); saveSettings(); });
  $('#set-ctx').addEventListener('change', e => { settings.numCtx = parseInt(e.target.value, 10); saveSettings(); updateMeter('case'); updateMeter('reflection'); });
  $('#set-think').addEventListener('change', e => { settings.think = e.target.value; saveSettings(); });
  $('#set-maximg').addEventListener('change', e => { settings.maxImages = parseInt(e.target.value, 10); saveSettings(); });
  $('#set-vision').addEventListener('change', e => { settings.openaiVision = e.target.checked; saveSettings(); refreshVisionUI(); updateCaseMeta(); });

  // プロンプト編集
  for (const r of $$('input[name=ptool]', d)) r.addEventListener('change', loadPromptPane);
  $('#set-knowledge').addEventListener('input', () => { $('#set-know-count').textContent = `${fmt(countChars($('#set-knowledge').value))}字`; });
  $('#set-know-file').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const status = $('#set-prompt-status');
    try {
      status.textContent = `${f.name} を読み込んでいます…`;
      const res = await extractFile(f, {});
      const ta = $('#set-knowledge');
      ta.value = (ta.value.trim() ? ta.value.trim() + '\n\n' : '') + `【${f.name}】\n` + res.text;
      ta.dispatchEvent(new Event('input'));
      status.textContent = `${f.name} を追加しました。「保存する」で反映されます。`;
    } catch (err) { status.textContent = err.message; }
  });
  $('#set-prompt-save').addEventListener('click', () => {
    const tool = $('input[name=ptool]:checked', d).value;
    const sys = $('#set-system').value;
    const def = tool === 'case' ? P.CASE_SYSTEM_TEMPLATE : P.REFLECTION_SYSTEM_TEMPLATE;
    prompts[tool] = { system: sys.trim() === def.trim() ? '' : sys, knowledge: $('#set-knowledge').value };
    if (!prompts[tool].system && !prompts[tool].knowledge.trim()) delete prompts[tool];
    store.set(KEY_PROMPTS, prompts);
    $('#set-prompt-status').textContent = '保存しました（このブラウザのみ）。次の新しい評価から使われます。今の対話に反映するには「新しく始める」を押してください。';
  });
  $('#set-prompt-reset').addEventListener('click', () => {
    const tool = $('input[name=ptool]:checked', d).value;
    if (!confirm('この対象の指示文と参考資料を既定に戻しますか？')) return;
    delete prompts[tool];
    store.set(KEY_PROMPTS, prompts);
    loadPromptPane();
    $('#set-prompt-status').textContent = '既定に戻しました。';
  });
  $('#set-clear').addEventListener('click', () => {
    if (!confirm('このブラウザに保存した設定とプロンプト編集をすべて消しますか？')) return;
    store.del(KEY_SETTINGS);
    store.del(KEY_PROMPTS);
    settings = { ...DEFAULT_SETTINGS };
    prompts = {};
    conn.status = 'unknown'; conn.models = []; conn.info = null;
    openSettings();
    updateBoundary();
    $('#set-clear-status').textContent = '消しました。';
  });
}

function loadPromptPane() {
  const tool = $('input[name=ptool]:checked', dlgSettings).value;
  $('#set-system').value = templateFor(tool);
  $('#set-knowledge').value = knowledgeFor(tool);
  $('#set-know-count').textContent = `${fmt(countChars(knowledgeFor(tool)))}字`;
  $('#set-prompt-status').textContent = prompts[tool] ? 'このブラウザで編集した内容を表示しています。' : '既定の内容を表示しています。';
}

// ---------------------------------------------------------------------
// 準備と使い方
// ---------------------------------------------------------------------
function wireHelp() {
  const d = $('#help');
  wireTabs(d);
  const origin = location.origin;
  $('[data-origin-cmd=win]', d).textContent = `[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "${origin}", "User")`;
  $('[data-origin-cmd=mac]', d).textContent = `launchctl setenv OLLAMA_ORIGINS "${origin}"`;
  $('[data-origin-cmd=wincheck]', d).textContent = `curl.exe -i -H "Origin: ${origin}" http://localhost:11434/api/tags`;
  for (const b of $$('.copy', d)) b.addEventListener('click', () => copyText($('code', b.parentElement).textContent, b));
}

// ---------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------
function init() {
  // ツール切り替え（#case / #reflection で直接開ける）
  for (const b of $$('.tools [role=tab]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  setTool(location.hash === '#reflection' ? 'reflection' : 'case', { updateHash: false });

  // 資質・能力のチップ
  $('#reflection-comps').append(...P.COMPETENCIES.map(c => el('label', {}, el('input', { type: 'checkbox', value: c }), el('span', { text: c }))));

  // 症例報告フォーム
  const cf = $('#case-form');
  cf.addEventListener('submit', submitCase);
  for (const r of cf.querySelectorAll('input[name=mode]')) r.addEventListener('change', updateCaseMeta);
  for (const n of ['charLimit', 'minutes']) cf[n].addEventListener('input', updateCaseMeta);
  $('#case-send-images').addEventListener('change', updateCaseMeta);
  $('#case-text').addEventListener('input', () => { updateCaseMeta(); renderPiiLater.case(); });
  $('#case-text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cf.requestSubmit(); } });

  // 振り返りフォーム
  const rf = $('#reflection-form');
  rf.addEventListener('submit', submitReflection);
  $('#reflection-text').addEventListener('input', () => { updateReflectionMeta(); renderPiiLater.reflection(); });
  $('#reflection-text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); rf.requestSubmit(); } });

  wireDrop('case');
  wireDrop('reflection');
  wireDialogue('case');
  wireDialogue('reflection');
  wireSettings();
  wireHelp();

  // 汎用ボタン
  document.addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) {
      e.preventDefault();
      if (open.dataset.open === 'settings') openSettings();
      if (open.dataset.open === 'diagnose') { openSettings(); diagnose(); }
      if (open.dataset.open === 'help') { const h = $('#help'); if (!h.open) h.showModal(); }
    }
    const pick = e.target.closest('[data-pick]');
    if (pick) $(`#${pick.dataset.pick}`).click();
  });
  $('#open-settings').addEventListener('click', () => openSettings());
  $('#open-help').addEventListener('click', () => $('#help').showModal());
  $('#open-session').addEventListener('click', () => $('#session-file').click());
  $('#session-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openSessionFile(f); });

  // ページの外にファイルを落としたとき、ブラウザで開いてしまわないように
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  window.addEventListener('beforeunload', e => {
    if (Object.values(sessions).some(s => s.dirty && s.messages.length)) { e.preventDefault(); e.returnValue = ''; }
  });

  updateCaseMeta();
  updateReflectionMeta();
  renderLog('case');
  renderLog('reflection');
  updateBoundary();
  connect({ quiet: true }).then(() => { renderLog('case'); renderLog('reflection'); });
}

init();
