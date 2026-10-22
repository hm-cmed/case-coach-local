// =====================================================================
// privacy.js — 個人を特定しうる情報の簡易チェック（ブラウザ内で実行）
// 発表・ポートフォリオの「中身」の匿名化を助けるための目印で、網羅を保証するものではない。
// =====================================================================

const KANJI = '\\p{Script=Han}';
const NOT_NAMES = new Set([
  '患者', '本人', '家族', '妻', '夫', '母', '父', '娘', '息子', '長男', '長女', '次男', '次女', '祖母', '祖父',
  '孫', '兄', '姉', '弟', '妹', '主治医', '担当医', '先生', '看護師', '利用者', '奥', '旦那', '皆', '皆様',
  '患者様', '利用者様', '先方', '相手', '上司', '同僚', '友人', 'お客',
  '医師', '薬剤師', '技師', '介護士', '栄養士', '保健師', '助産師', '職員', '店員', '運転手', '家族様',
  'ヘルパー', 'スタッフ', 'ドクター', 'ナース', '研修医', '専攻医', '指導医', '学生', '部長', '院長', '師長',
  'お嬢', '息子様', '娘様', 'ご家族', '患者家族', '病棟', '外来', '担当', '主治', '指導', '担任', '学校', '大学',
]);

const RULES = [
  {
    type: 'date', label: '日まで含む日付',
    re: /(?:(?:19|20)\d{2}|令和\s*\d{1,2}|平成\s*\d{1,2}|R\s?\d{1,2}|H\s?\d{1,2})\s*(?:年|[\/.\-])\s*\d{1,2}\s*(?:月|[\/.\-])\s*\d{1,2}\s*日?/gu,
    hint: '経過は「第○病日」「入院○日目」「X年Y月」などに置き換えるのが一般的です',
  },
  {
    type: 'date', label: '月日',
    re: /(?<![\d年])\d{1,2}\s*月\s*\d{1,2}\s*日/gu,
    hint: '「第○病日」などの相対表記を検討してください',
  },
  {
    type: 'id', label: 'ID・番号',
    re: /(?:ID|ＩＤ|カルテ|患者番号|診察券|保険証|受付番号|検体番号)\s*(?:番号)?\s*[:：#＃]?\s*[A-Za-z0-9０-９\-]{3,}/gu,
    hint: 'ID・番号は削除してください',
  },
  {
    type: 'id', label: '長い数字列',
    re: /(?<![\d.])\d{7,}(?![\d.])/gu,
    hint: 'ID や電話番号でないか確認してください',
  },
  {
    type: 'contact', label: '電話番号',
    re: /0\d{1,4}[-‐－]\d{1,4}[-‐－]\d{3,4}/gu,
    hint: '削除してください',
  },
  {
    type: 'contact', label: '郵便番号',
    re: /〒?\s?\d{3}[-‐－]\d{4}/gu,
    hint: '削除してください',
  },
  {
    type: 'contact', label: 'メールアドレス',
    re: /[\w.+-]+@[\w-]+\.[\w.-]+/gu,
    hint: '削除してください',
  },
  {
    type: 'name', label: 'イニシャル',
    re: /(?<![A-Za-zＡ-Ｚａ-ｚ])[A-ZＡ-Ｚ][.．・][\s　]?[A-ZＡ-Ｚ][.．]?(?=[\s　]*(?:さん|様|氏|くん|ちゃん|患者|の|は|が|、|。)|$)/gmu,
    hint: '症例報告ではイニシャルも記載しないのが一般的です',
  },
  {
    type: 'name', label: '人名らしき語',
    re: new RegExp(`(?<![${KANJI}ァ-ヶー])[${KANJI}ァ-ヶー]{2,4}(?:さん|様|氏|くん|ちゃん|先生)`, 'gu'),
    filter: m => !NOT_NAMES.has(m.replace(/(さん|様|氏|くん|ちゃん|先生)$/, '')),
    hint: '実名であれば「患者」「Aさん」「指導医」などに置き換えてください',
  },
  {
    type: 'place', label: '医療機関名',
    re: new RegExp(`[${KANJI}ァ-ヶーA-Za-z]{2,12}(?:病院|医院|クリニック|診療所|医療センター)`, 'gu'),
    filter: m => !/^(当|同|前|近医|近隣|他|紹介元|かかりつけ|地域|総合|大学|一般|専門)/.test(m) || m.length > 6,
    hint: '演者の所属表記なら問題ありません。患者の受診先なら「前医」「近医」に',
  },
  {
    type: 'place', label: '住所',
    re: new RegExp(`(?:北海道|東京都|大阪府|京都府|[${KANJI}]{2,3}県)[${KANJI}]{1,5}(?:市|区|町|村|郡)(?:[${KANJI}]{1,5}(?:町|丁目))?`, 'gu'),
    hint: '居住地の詳細は避け、必要なら「○○地方」程度に',
  },
];

/**
 * @param {string} text
 * @returns {{type:string,label:string,match:string,index:number,hint:string}[]}
 */
export function scanPersonalInfo(text) {
  const s = String(text || '');
  const found = [];
  const taken = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(s))) {
      const hit = m[0].trim();
      if (!hit) continue;
      if (rule.filter && !rule.filter(hit)) continue;
      const start = m.index, end = m.index + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue; // 重複検出は先のルールを優先
      taken.push([start, end]);
      found.push({ type: rule.type, label: rule.label, match: hit, index: start, hint: rule.hint });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** 検出箇所を「●」で伏せる（人名は「〇〇さん」→「●●さん」のように敬称を残す） */
export function maskPersonalInfo(text, hits) {
  let s = String(text || '');
  const sorted = [...hits].sort((a, b) => b.index - a.index);
  for (const h of sorted) {
    const at = s.indexOf(h.match, h.index);
    if (at < 0) continue;
    let rep;
    if (h.label === '人名らしき語') {
      const suf = (h.match.match(/(さん|様|氏|くん|ちゃん|先生)$/) || [''])[0];
      rep = '●●' + suf;
    } else {
      rep = '●'.repeat(Math.min(6, [...h.match].length));
    }
    s = s.slice(0, at) + rep + s.slice(at + h.match.length);
  }
  return s;
}
