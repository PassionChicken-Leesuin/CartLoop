// LLM 에이전트들: 추출 · 별칭 통합 · 공지 규칙 · 술식 연결 · 재료 묻기
import { MODEL_FAST, MODEL_SMART } from './llm.js';
import { norm } from './text.js';

// ───────────────────────── ① 추출 에이전트 ─────────────────────────
const EXTRACT_SYS = `너는 병원 수술간호기록지에서 필요한 값만 뽑아 JSON으로 돌려주는 추출기다.
입력은 PDF·워드 문서나 EHR 화면에서 읽은 글자이며, 표의 칸은 " | " 로 나뉘어 있다.

표는 열을 맞춰 두었고 빈 칸은 "∅" 로 표시된다. 표 머리글 줄과 값 줄은 칸 순서가 같다.
- 재료 표의 열은 (구획 이름) · 재료코드 · 재료명 · 규격 · 수량 · 단위 순이다. 각 값은 같은 순서의 머리글에 해당한다.
  재료코드 칸이 ∅ 이면 code 는 "" 이다. 다른 줄의 코드를 가져오지 않는다. 규격 칸이 ∅ 이면 spec 은 "" 이다.
- 줄 하나가 재료 하나다. 줄을 합치거나 나누지 않고, 위아래 줄의 글자를 섞지 않는다.
- 한 칸 안에서 줄이 넘어간 글자는 이미 한 칸으로 이어 붙여져 있다. 이어 붙은 자리에 생긴 공백은 낱말 중간이면 지운다
  (예: "cann. screw (가 상트라우마)" → "cann. screw (가상트라우마)", "PLIF PEEK ( 가상 메디칼 )" → "PLIF PEEK (가상메디칼)").
- 결과에 "∅" 를 넣지 않는다.
한글 사이에 잘못 끼어든 공백은 지운다(예: "C 교수" → "C교수", "하 OO" → "하OO", "( 가상 메디칼 )" → "(가상메디칼)").

규칙
- 적힌 그대로 옮긴다. 재료명·규격을 표준 이름으로 바꾸거나 추측해서 채우지 않는다.
- 재료코드 칸이 비어 있으면 code 는 "" 로 둔다.
- "2. 치료재료 및 고가소모품" 표의 각 줄을 materials 에 순서대로 넣는다. 재료명 뒤 괄호 속 제조사는 name 에 그대로 둔다.
- "1. 삽입관" 표의 각 줄을 drains 에 넣는다. type 은 종류, note 는 참고사항 그대로.
- 약물·검체·장비는 넣지 않는다.
- 날짜는 YYYY-MM-DD. surgery_date 는 "수술 시작일시"의 날짜다.
- 값이 없으면 빈 문자열.

JSON 하나만 출력한다. 설명·코드블록 금지. 형식:
{"patient_id":"","surgery_date":"","scrub_nurse":"","circulating_nurse":"","site":"","diagnosis":"","op_name":"","op_code":"","surgeon":"","dept":"","room":"","note":"",
 "materials":[{"code":"","name":"","spec":"","qty":1,"unit":""}],
 "drains":[{"type":"","note":""}]}`;

export async function extractRecord(llm, text) {
  const r = await llm.call({
    model: MODEL_FAST, json: true, max_tokens: 1500,
    messages: [{ role: 'system', content: EXTRACT_SYS }, { role: 'user', content: text }],
  });
  return cleanRecord(r.data);
}

export function cleanRecord(d) {
  const s = v => norm(v == null ? '' : String(v));
  const fixKo = v => s(v).replace(/([A-Za-z가-힣])\s+(교수|OO)/g, '$1$2');
  return {
    pid: s(d.patient_id).replace(/\D/g, ''),
    date: s(d.surgery_date).slice(0, 10),
    scrub: s(d.scrub_nurse), circ: s(d.circulating_nurse),
    site: s(d.site), diagnosis: s(d.diagnosis),
    opName: s(d.op_name), opCode: s(d.op_code),
    surgeon: fixKo(d.surgeon), dept: s(d.dept), room: s(d.room), note: s(d.note),
    materials: (Array.isArray(d.materials) ? d.materials : []).filter(m => m && (m.name || m.spec)).map(m => ({
      code: s(m.code), name: s(m.name), spec: s(m.spec), qty: Number(m.qty) || 1, unit: s(m.unit),
    })),
    drains: (Array.isArray(d.drains) ? d.drains : []).filter(x => x && s(x.type)).map(x => ({ type: s(x.type), note: s(x.note) })),
  };
}

// ───────────────────────── ② 별칭 통합 에이전트 ─────────────────────────
const ALIAS_SYS = `너는 병원 수술실에서 쓰는 치료재료의 현장 호칭을 병원 재료 마스터의 품목군에 잇는 일을 한다.
입력으로 (1) 품목군 목록과 (2) 간호사가 기록지에 적은 호칭 목록을 받는다.
호칭은 약어·한글 음차·오타·제조사명이 섞여 있다. 호칭마다 함께 적힌 규격 예시와 쓰인 수술명이 붙어 있으니, 규격이 그 품목군의 규격 체계와 맞는지도 함께 본다.

- 각 호칭에 가장 알맞은 품목군 id 하나를 고른다. 목록에 맞는 품목군이 없으면 null.
- 뜻이 비슷한 품목군이 여럿이면 규격 예시와 수술명으로 가린다
  (예: 규격이 "40g" 이고 인공관절 수술이면 일반 골시멘트, "PMMA 20g" 이고 척추성형술이면 척추성형용 시멘트 키트).
- conf 는 확신 정도 0~1.

JSON 하나만 출력한다: {"map":[{"alias":"호칭","family":"품목군 id 또는 null","conf":0.9}]}`;

export function familyCatalog(db, onlyFamilies) {
  const fams = Object.values(db.families).filter(f => !onlyFamilies || onlyFamilies.has(f.id));
  return fams.map(f => {
    const specs = f.codes.slice(0, 8).map(c => db.master[c].spec).filter(Boolean).join(', ');
    return `- id: ${f.id} | 제조사: ${f.maker || '-'} | 규격: ${specs}${f.codes.length > 8 ? ' …' : ''} | ${f.benefits.join('/')}`;
  }).join('\n');
}

export async function proposeFamilies(llm, db, aliasInfos, onProgress) {
  // aliasInfos: [{alias, specs:[...], ops:[...], makers:[...]}]
  const catalog = familyCatalog(db);
  const batches = [];
  for (let i = 0; i < aliasInfos.length; i += 25) batches.push(aliasInfos.slice(i, i + 25));
  const out = {};
  const res = await llm.mapAll(batches, async batch => {
    const list = batch.map(a => `- "${a.alias}" | 규격 예: ${a.specs.slice(0, 5).join(', ') || '-'} | 제조사 표기: ${a.makers.slice(0, 2).join(', ') || '-'} | 수술: ${a.ops.slice(0, 3).join(' / ') || '-'}`).join('\n');
    const r = await llm.call({
      model: MODEL_FAST, json: true, max_tokens: 2500,
      messages: [{ role: 'system', content: ALIAS_SYS },
        { role: 'user', content: `[품목군 목록]\n${catalog}\n\n[호칭 목록]\n${list}` }],
    });
    return r.data.map || [];
  }, onProgress);
  for (const b of res) if (Array.isArray(b)) for (const m of b) {
    if (m && m.alias && m.family && db.families[m.family]) out[norm(m.alias).toLowerCase()] = { family: m.family, conf: Number(m.conf) || 0.5 };
  }
  return out;
}

// ───────────────────────── ③ 공지 규칙 에이전트 ─────────────────────────
const RULE_SYS = `너는 병원 재료관리팀·보험심사팀의 공지문을 읽어, 청구 점검 프로그램이 쓸 수 있는 규칙으로 바꾼다.
공지 하나마다 규칙 객체 하나를 만든다. 공지문에 적힌 것만 쓰고 추측으로 코드를 지어내지 않는다.

type 은 다음 중 하나:
- "non_billable": 특정 품목을 청구 목록에 넣으면 안 됨(산정불가·행위료 포함). codes 에 해당 재료코드.
- "bundled": 정액(묶음) 수가에 포함되어 따로 청구할 수 없는 품목이 있음. bundle_code 에 정액 재료코드, bundle_class 에 중분류코드, keywords 에 포함 품목 이름들(영문 대문자 그대로), once_per_op 는 정액을 수술 1회당 1회만 산정하면 true.
- "qty_limit": 수술 1회당 수량 한도. keywords 에 품목 이름, max_per_op 에 한도.
- "price_change": 상한금액·단가 변경. class_codes 에 중분류코드, pct 에 변동률(인하면 음수, 예 -4.5).
- "discontinued": 특정 품목·규격 사용 중지. codes 에 중지된 재료코드, replacement 에 대체 재료코드.
- "set_policy": Case cart 세트 개정 기준. implant: {"window":10,"min":8,"basis":"record"}, consumable: {"window":20,"min":17,"basis":"claim"} 처럼 채운다.
- "info": 청구 점검에 쓸 규칙이 없는 안내.

JSON 하나만 출력한다:
{"rules":[{"no":1,"title":"","doc_no":"","effective":"YYYY-MM-DD","type":"","codes":[],"class_codes":[],"keywords":[],"bundle_code":"","bundle_class":"","once_per_op":false,"max_per_op":null,"pct":null,"replacement":"","implant":null,"consumable":null,"summary":"한 문장 요약"}]}`;

export async function extractRules(llm, noticeText) {
  const r = await llm.call({
    model: MODEL_SMART, json: true, max_tokens: 3000,
    messages: [{ role: 'system', content: RULE_SYS }, { role: 'user', content: noticeText }],
  });
  return cleanRules(r.data.rules || []);
}
export function cleanRules(rules) {
  const arr = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : [];
  return rules.map((r, i) => ({
    no: Number(r.no) || i + 1, title: norm(r.title), docNo: norm(r.doc_no), effective: String(r.effective || '').slice(0, 10),
    type: String(r.type || 'info'), codes: arr(r.codes), classCodes: arr(r.class_codes), keywords: arr(r.keywords),
    bundleCode: norm(r.bundle_code), bundleClass: norm(r.bundle_class), oncePerOp: !!r.once_per_op,
    maxPerOp: r.max_per_op == null ? null : Number(r.max_per_op), pct: r.pct == null ? null : Number(r.pct),
    replacement: norm(r.replacement), implant: r.implant || null, consumable: r.consumable || null, summary: norm(r.summary),
  }));
}

// ───────────────────────── ④ 술식 연결 에이전트 ─────────────────────────
const PROC_SYS = `수술간호기록지의 수술명을 Case cart 세트 목록의 술식 이름에 잇는다.
기록지 수술명은 영문 풀네임이고 세트의 술식 이름은 병원에서 부르는 약칭이다.
각 수술명에 맞는 술식 이름을 [세트 술식 목록] 안에서 그대로 골라라. 맞는 것이 없으면 null.
JSON 하나만 출력한다: {"map":[{"op":"기록지 수술명","procedure":"세트 술식 이름 또는 null"}]}`;

export async function mapProcedures(llm, opStems, setProcedures) {
  const r = await llm.call({
    model: MODEL_FAST, json: true, max_tokens: 1500,
    messages: [{ role: 'system', content: PROC_SYS },
      { role: 'user', content: `[세트 술식 목록]\n${setProcedures.map(p => '- ' + p).join('\n')}\n\n[기록지 수술명]\n${opStems.map(p => '- ' + p).join('\n')}` }],
  });
  const out = {};
  for (const m of r.data.map || []) if (m?.op && m.procedure && setProcedures.includes(m.procedure)) out[norm(m.op)] = m.procedure;
  return out;
}

// ───────────────────────── ⑤ 재료 묻기 에이전트 ─────────────────────────
const QA_SYS = `너는 CartLoop의 "우리 병원 재료 묻기" 도우미다. 수술실 간호사의 질문에, 아래 [우리 병원 기록]에 있는 내용만으로 답한다.

- 기록에 없는 것은 "우리 병원 기록에는 없습니다"라고 답한다. 일반 의학 지식으로 채우지 않는다.
- 진단·치료·수술 방법을 추천하지 않는다. 그런 질문에는 답할 수 없다고 짧게 말한다.
- 재료는 병원 재료코드와 규격을 함께 적는다.
- 근거가 된 수술번호를 문장 끝에 [OP25-0001] 형식으로 붙인다. 근거가 여러 건이면 대표 3건까지.
- 숫자(몇 건 중 몇 건)는 기록에 적힌 그대로 쓴다.
- 간호사가 바로 읽고 움직일 수 있게 3~6문장으로 짧게, 존댓말로 답한다. 마크다운 표·제목은 쓰지 않는다.`;

export async function answerQuestion(llm, question, context, history = []) {
  const r = await llm.call({
    model: MODEL_SMART, max_tokens: 900, temperature: 0.2,
    messages: [{ role: 'system', content: QA_SYS },
      ...history.slice(-4),
      { role: 'user', content: `[우리 병원 기록]\n${context}\n\n[질문]\n${question}` }],
  });
  return r.content.trim();
}
