// 파일 판독 에이전트(규칙 부분): 파일 이름이 아니라 머리글과 열의 뜻, 본문 내용으로 종류를 판별한다.
import { decodeText, parseCSV, tableToObjects, pdfToLines, docxToLines, xlsxToRows } from './readers.js';

// 열의 뜻 → 표준 필드. 병원마다 머리글이 달라도 같은 뜻이면 같은 필드로 읽는다.
const CONCEPTS = {
  op: ['수술번호', '수술no', '수술id', 'opno', 'op번호', '케이스번호'],
  date: ['수술일', '수술일자', '시행일', '일자'],
  pid: ['등록번호', '환자번호', '환자등록번호', '차트번호'],
  seq: ['순번', '줄번호', 'no'],
  code: ['재료코드', '품목코드', '코드', 'edi코드', '보험코드'],
  name: ['재료명', '품명', '품목명', '명칭'],
  spec: ['규격', '사이즈', 'size', '규격단위'],
  qty: ['수량', '청구수량', '사용수량'],
  unit: ['단위'],
  price: ['단가', '청구단가'],
  amount: ['금액', '청구금액', '합계'],
  benefit: ['급여구분', '급여여부', '구분코드'],
  status: ['전송상태', '상태'],
  cap: ['상한금액', '상한가', '급여상한금액'],
  maker: ['제조·수입사', '제조사', '수입사', '제조수입사', '업체'],
  cls: ['중분류코드', '분류코드'],
  clsName: ['중분류명', '분류명'],
  note: ['비고', '메모'],
  setCode: ['세트코드', '세트id', 'set코드'],
  surgeon: ['집도의', '집도의사', '의사'],
  procedure: ['수술명', '술식'],
  level: ['레벨·부위', '레벨', '부위', '레벨부위'],
  version: ['버전', 'ver', 'version'],
  revised: ['개정일', '수정일', '개정일자'],
  kind: ['구분', '분류'],
};
const key = h => String(h).toLowerCase().replace(/[\s_·./()-]/g, '');
const LOOKUP = {};
for (const [field, syns] of Object.entries(CONCEPTS)) for (const s of syns) (LOOKUP[key(s)] ||= []).push(field);

export function mapHeader(header) {
  const map = {}; // 표준필드 → 원래 머리글
  for (const h of header) {
    for (const f of LOOKUP[key(h)] || []) if (!(f in map)) { map[f] = h; break; }
  }
  return map;
}

const SIGNS = {
  claims: { need: ['op', 'code', 'qty'], any: ['amount', 'price', 'status'] },
  master: { need: ['code', 'name', 'cap'], any: ['benefit', 'maker', 'cls'] },
  sets: { need: ['setCode', 'code', 'qty'], any: ['surgeon', 'version', 'revised'] },
};
export const KIND_LABEL = {
  record: '수술간호기록지', claims: '치료재료 청구목록', master: '재료 마스터', sets: 'Case cart 세트 목록',
  notices: '기준 변경 공지', unknown: '판별 불가',
};

function classifyTable(header) {
  const map = mapHeader(header);
  let best = null;
  for (const [kind, sign] of Object.entries(SIGNS)) {
    if (!sign.need.every(f => f in map)) continue;
    const score = sign.need.length + sign.any.filter(f => f in map).length * 2;
    if (!best || score > best.score) best = { kind, score };
  }
  return { kind: best?.kind || 'unknown', map };
}

const num = v => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;
function pick(row, map, f) { return map[f] ? (row[map[f]] ?? '') : ''; }

export function shapeRows(kind, rows, map) {
  if (kind === 'claims') return rows.map(r => ({
    op: pick(r, map, 'op'), date: pick(r, map, 'date'), pid: pick(r, map, 'pid'), seq: num(pick(r, map, 'seq')),
    code: pick(r, map, 'code'), name: pick(r, map, 'name'), spec: pick(r, map, 'spec'), qty: num(pick(r, map, 'qty')),
    unit: pick(r, map, 'unit'), price: num(pick(r, map, 'price')), amount: num(pick(r, map, 'amount')),
    benefit: pick(r, map, 'benefit'), status: pick(r, map, 'status'),
  })).filter(r => r.op && r.code);
  if (kind === 'master') return rows.map(r => ({
    code: pick(r, map, 'code'), name: pick(r, map, 'name'), spec: pick(r, map, 'spec'), unit: pick(r, map, 'unit'),
    maker: pick(r, map, 'maker'), cls: pick(r, map, 'cls'), clsName: pick(r, map, 'clsName'), cap: num(pick(r, map, 'cap')),
    benefit: pick(r, map, 'benefit'), note: pick(r, map, 'note'),
  })).filter(r => r.code);
  if (kind === 'sets') return rows.map(r => ({
    setCode: pick(r, map, 'setCode'), surgeon: pick(r, map, 'surgeon'), procedure: pick(r, map, 'procedure'),
    level: pick(r, map, 'level'), version: pick(r, map, 'version'), revised: pick(r, map, 'revised'),
    kind: pick(r, map, 'kind'), code: pick(r, map, 'code'), name: pick(r, map, 'name'), spec: pick(r, map, 'spec'),
    qty: num(pick(r, map, 'qty')),
  })).filter(r => r.setCode);
  return rows;
}

// 파일 하나를 읽어 종류와 내용을 돌려준다.
//   deps: { pdfjs, unzipSync }
export async function readFile(name, buf, deps) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();
  const out = { name, ext, size: buf.byteLength ?? buf.length, kind: 'unknown', why: '' };
  try {
    if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx') {
      const raw = ext === 'xlsx' ? xlsxToRows(buf, deps.unzipSync) : parseCSV(decodeText(buf));
      const t = tableToObjects(raw);
      const c = classifyTable(t.header);
      out.kind = c.kind;
      out.headerRow = t.headerRow;
      out.header = t.header;
      out.fieldMap = c.map;
      out.rows = shapeRows(c.kind, t.rows, c.map);
      out.why = `${t.headerRow}행 머리글: ${Object.entries(c.map).slice(0, 6).map(([f, h]) => h).join(' · ')}`;
      return out;
    }
    let lines;
    if (ext === 'pdf') lines = await pdfToLines(buf, deps.pdfjs);
    else if (ext === 'docx') lines = docxToLines(buf, deps.unzipSync);
    else lines = decodeText(buf).split(/\r?\n/);
    const text = lines.join('\n');
    out.text = text;
    const head = text.slice(0, 3000);
    const nNotice = (text.match(/\[공지\s*\d+\]|문서번호\s*:/g) || []).length;
    const isForm = /환자\s*등록번호|수술\s*시작일시/.test(text) && /수술명/.test(text);
    if (isForm) {
      out.kind = 'record'; out.why = '본문에 수술간호기록 서식 항목(등록번호 · 수술명 · 치료재료 · 집도의)';
    } else if (nNotice >= 1 && /시행일|적용일/.test(text)) {
      out.kind = 'notices'; out.why = `시행일이 있는 안내문 ${(text.match(/시행일|적용일/g) || []).length}건`;
    } else out.why = '알려진 서식과 맞지 않음';
    return out;
  } catch (e) {
    out.error = String(e?.message || e);
    out.why = '읽기 실패: ' + out.error;
    return out;
  }
}
