// =====================================================================
// scores.js — AIが出した採点ブロックを読み取り、合計とランクをアプリ側で計算し直す
// （ローカルLLMは足し算を誤ることがあるため、合計は必ずアプリが出す）
// =====================================================================
import { rankOf, GIBBS_STAGES, DEPTH_LEVELS } from './prompts.js';

const norm = s => String(s).replace(/[\s　・、,（）()]/g, '').replace(/^\d+[.)．]?/, '');

/**
 * @param {string} text  AIの返答全文
 * @param {{name:string,max:number}[]} rubric
 */
export function parseScores(text, rubric) {
  const block = String(text).match(/```\s*scores\s*\n([\s\S]*?)```/i);
  if (!block) return null;
  const rows = [];
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:\d+[.)．]\s*)?(.+?)\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:点)?\s*[\/／]\s*(\d+)/);
    if (m) rows.push({ name: m[1].trim(), score: parseFloat(m[2]), max: parseInt(m[3], 10) });
  }
  if (!rows.length) return null;

  const used = new Set();
  const items = rubric.map((r, idx) => {
    const key = norm(r.name);
    let hit = rows.findIndex((row, k) => !used.has(k) && (norm(row.name) === key || norm(row.name).includes(key) || key.includes(norm(row.name))));
    if (hit < 0 && rows[idx] && !used.has(idx)) hit = idx; // 名前が崩れていたら順番で対応づけ
    if (hit < 0) return { name: r.name, max: r.max, score: null };
    used.add(hit);
    const raw = rows[hit].score;
    const scaled = rows[hit].max && rows[hit].max !== r.max ? raw * r.max / rows[hit].max : raw;
    return { name: r.name, max: r.max, score: Math.max(0, Math.min(r.max, Math.round(scaled))) };
  });

  const complete = items.every(it => it.score !== null);
  const total = items.reduce((a, it) => a + (it.score ?? 0), 0);
  const maxTotal = rubric.reduce((a, r) => a + r.max, 0);
  const stated = String(text).match(/総合\s*[:：]?\s*(\d{1,3})\s*点/);
  return {
    items, total, maxTotal, complete,
    rank: rankOf(total * 100 / maxTotal),
    statedTotal: stated ? parseInt(stated[1], 10) : null,
  };
}

const LEVEL = { '十分': 2, '一部': 1, 'なし': 0 };

export function parseGibbs(text) {
  const block = String(text).match(/```\s*gibbs\s*\n([\s\S]*?)```/i);
  if (!block) return null;
  const stages = {};
  let depth = null;
  for (const line of block[1].split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s*)?(.+?)\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].replace(/\s/g, '');
    const val = m[2].replace(/[。.]$/, '');
    if (key === '水準' || key === '深さ') { depth = DEPTH_LEVELS.find(d => val.includes(d)) || val; continue; }
    const stage = GIBBS_STAGES.find(s => key.startsWith(s));
    if (!stage) continue;
    const lv = Object.keys(LEVEL).find(l => val.includes(l));
    stages[stage] = lv ? LEVEL[lv] : null;
  }
  if (!Object.keys(stages).length) return null;
  return { stages, depth };
}
