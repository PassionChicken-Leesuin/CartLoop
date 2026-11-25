// 표기 정규화 도구: 별칭 키, 규격 숫자, 품목군 이름.

export const squash = s => String(s ?? '').replace(/\s+/g, '');
export const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// 기록지 재료명 → 별칭 키. 괄호 안 제조사와 공백·대소문자 차이를 걷어낸다.
export function aliasKey(name) {
  return norm(String(name ?? '').replace(/\s*\([^)]*\)?\s*$/, '')).toLowerCase();
}
export function makerHint(name) {
  const m = /\(([^)]*)\)?\s*$/.exec(String(name ?? ''));
  return m ? squash(m[1]) : '';
}

// 문자열 속 숫자들 (규격 비교용). "6.5×45mm" → [6.5,45], "#3-4 12T" → [3,4,12]
export function nums(s) {
  return (String(s ?? '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
}
const UNIT_WORDS = new Set(['mm', 'ml', 'cc', 'g', 'fr', 'cm', 'ea', 'size', 'id', 'gs', 'h', 'l', 't', 'pp', 'x', 's', 'm', 'kit', 'set', 'pk', 'mg', 'in']);
const SYN = { std: 'standard', nar: 'narrow', wd: 'wide', 표준: 'standard' };
export function words(s) {
  return (String(s ?? '').toLowerCase().match(/[a-z가-힣]+/g) || [])
    .map(w => SYN[w] || w).filter(w => !UNIT_WORDS.has(w));
}

const SIZE_TOKEN = /^\(?(?:[hø#]?\d+(?:\.\d+)?(?:[-*x×/]\d+(?:\.\d+)?)*(?:mm|ml|cc|g|fr|cm|㎛|"|'|°|%)?)\)?$/i;
// 마스터 품명에서 크기 토큰을 걷어내 품목군 이름을 만든다.
//   "CRESCENT TITANIUM (26mm) H8" → "CRESCENT TITANIUM"   "COLLASTAT 6ml" → "COLLASTAT"
export function splitFamily(itemName) {
  let s = String(itemName ?? '').replace(/\(([^()]*\d[^()]*)\)/g, (m, inner) =>
    /^[\d\s.*x×/a-zA-Z㎛"']+$/.test(inner) && /\d/.test(inner) && !/[a-zA-Z]{4,}/.test(inner.replace(/mm|cm|ml|ea/gi, '')) ? ` §${inner}§ ` : m);
  const sizeParts = [];
  s = s.replace(/§([^§]*)§/g, (m, inner) => { sizeParts.push(inner); return ' '; });
  const keep = [];
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    if (SIZE_TOKEN.test(tok)) sizeParts.push(tok); else keep.push(tok);
  }
  return { family: keep.join(' ').replace(/\s+-\s*$/, '').trim(), sizeText: sizeParts.join(' ') };
}

const sortedKey = a => a.slice().sort((x, y) => x - y).join(',');
function isSubMultiset(a, b) {
  const pool = b.slice();
  for (const x of a) { const i = pool.indexOf(x); if (i < 0) return false; pool.splice(i, 1); }
  return true;
}

// 품목군 안에서 기록지 규격 표기에 맞는 품목을 고른다.
// items: [{code, specNums, nameNums, specWords}]  →  {codes:[...], how}
export function matchSpec(items, specText, nameText = '') {
  if (!items.length) return { codes: [], how: 'none' };
  const n = nums(specText);
  const w = words(specText);
  if (n.length) {
    const key = sortedKey(n);
    const exact = items.filter(it => [it.specNums, it.nameNums, it.allNums].some(sig => sig.length && sortedKey(sig) === key));
    if (exact.length) return { codes: exact.map(i => i.code), how: 'exact' };
    const sub = items.filter(it => isSubMultiset(n, it.allNums));
    if (sub.length) return { codes: sub.map(i => i.code), how: 'subset' };
  }
  if (w.length) {
    const hit = items.filter(it => w.some(x => it.specWords.includes(x)));
    if (hit.length) return { codes: hit.map(i => i.code), how: 'word' };
  }
  if (items.length === 1) return { codes: [items[0].code], how: 'single' };
  // 규격 칸이 비었으면 이름에 든 숫자로 한 번 더
  const nn = nums(nameText);
  if (!n.length && nn.length) {
    const sub = items.filter(it => isSubMultiset(nn, it.allNums));
    if (sub.length) return { codes: sub.map(i => i.code), how: 'subset' };
  }
  return { codes: [], how: 'none' };
}

export function buildFamilies(masterRows) {
  const families = {};
  const master = {};
  for (const m of masterRows) {
    const { family, sizeText } = splitFamily(m.name);
    const fam = family || m.name;
    const item = {
      ...m, family: fam,
      specNums: nums(m.spec), nameNums: nums(sizeText),
      specWords: words(m.spec),
    };
    item.allNums = [...item.nameNums, ...item.specNums];
    master[m.code] = item;
    (families[fam] ||= { id: fam, name: fam, maker: m.maker, codes: [], benefits: new Set() });
    families[fam].codes.push(m.code);
    families[fam].benefits.add(m.benefit);
  }
  for (const f of Object.values(families)) {
    f.benefits = [...f.benefits];
    f.nonBillable = f.benefits.every(b => /산정\s*불가|별도\s*산정/.test(b));
    f.neverBilled = f.nonBillable;
  }
  return { master, families };
}

export const won = n => (Math.round(Number(n) || 0)).toLocaleString('ko-KR') + '원';
export const ymd = d => String(d ?? '').slice(0, 10);
