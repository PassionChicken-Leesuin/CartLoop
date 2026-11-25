// Knowledge Base 를 파일과 링크로 펼쳐 보인다. Loop DB의 내용을 폴더·문서 구조로 옮긴 것이다.
//   [[경로]] 는 다른 문서로 가는 링크다.
const won = n => (Number(n) || 0).toLocaleString('ko-KR') + '원';
const slug = s => String(s).replace(/[\\/:*?"<>|]/g, '_');

export function buildKB(db) {
  const files = {};
  const M = db.master;
  const famPath = f => `재료/${slug(f)}.md`;
  const setPath = c => `세트/${c}.md`;
  const opPath = r => `수술/${(r.date || '').slice(0, 7)}/${r.op}.md`;

  // 재료 (품목군) — 기록지에 한 번이라도 나온 것만
  const usedFams = new Set(Object.values(db.aliases).map(a => a.family).filter(Boolean));
  for (const f of usedFams) {
    const fam = db.families[f];
    const al = Object.values(db.aliases).filter(a => a.family === f).sort((a, b) => b.n - a.n);
    const st = db.famStat[f] || {};
    const rules = db.rules.filter(r => r.codes.some(c => fam.codes.includes(c)) || r.keywords.some(k => fam.name.toUpperCase().includes(k.toUpperCase())) || fam.codes.some(c => r.classCodes.includes(M[c].cls)));
    files[famPath(f)] = [
      `# ${fam.name}`, `제조·수입사: ${fam.maker || '-'} · 급여구분: ${fam.benefits.join(', ')}`, '',
      '## 품목', ...fam.codes.map(c => `- ${c} · ${M[c].spec} · 상한 ${won(M[c].cap)}`), '',
      '## 현장 호칭 (별칭 사전)', ...al.map(a => `- "${a.examples.join('", "')}" — ${a.n}회 · 근거 ${a.source}`), '',
      `## 대응 통계`, `기록지에 나온 수술 ${st.rec || 0}건 · 청구된 수술 ${st.claim || 0}건 · 둘 다 ${st.both || 0}건`, '',
      ...(rules.length ? ['## 관련 공지', ...rules.map(r => `- [[기준/공지-${r.no}.md]] ${r.title}`)] : []),
    ].join('\n');
  }
  // 세트
  for (const s of Object.values(db.sets)) {
    const ops = Object.values(db.records).filter(r => r.setCode === s.code).sort((a, b) => (b.date + b.op).localeCompare(a.date + a.op));
    files[setPath(s.code)] = [
      `# ${s.code} · ${s.surgeon} ${s.procedure} ${s.level}`, `버전 ${s.version} · 개정일 ${s.revised} · 집도의 [[집도의/${s.surgeon}.md]]`, '',
      '## 구성', ...s.items.map(i => `- [${i.kind}] ${i.name} ${i.spec} × ${i.qty}` + (M[i.code] && usedFams.has(M[i.code].family) ? ` → [[${famPath(M[i.code].family)}]]` : '')), '',
      '## 개정 이력', ...(s.history.length ? s.history.map(h => `- ${h.date} ${h.from} → ${h.to} (${h.by}): ` + h.changes.map(c => `${c.name} ${c.spec} ${c.from}→${c.to}`).join(', ')) : ['- 설치 뒤 개정 없음']), '',
      `## 이 세트로 한 수술 (${ops.length}건)`, ...ops.slice(0, 30).map(r => `- [[${opPath(r)}]] ${r.date}`),
    ].join('\n');
  }
  // 집도의
  for (const sg of new Set(Object.values(db.sets).map(s => s.surgeon))) {
    const mine = Object.values(db.sets).filter(s => s.surgeon === sg);
    const pref = {};
    for (const r of Object.values(db.records)) if (r.surgeon === sg) for (const l of r.lines) if (l.code) { const k = `${r.setCode}|${l.code}`; pref[k] = (pref[k] || 0) + 1; }
    files[`집도의/${sg}.md`] = [
      `# ${sg}`, '', '## 세트', ...mine.map(s => `- [[${setPath(s.code)}]] ${s.procedure} ${s.level} · ${s.version}`), '',
      '## 자주 쓰는 재료 (기록지 기준)',
      ...Object.entries(pref).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => { const [sc, c] = k.split('|'); return `- ${sc} · ${M[c].name} ${M[c].spec} — ${n}회 → [[${famPath(M[c].family)}]]`; }),
    ].join('\n');
  }
  // 기준
  for (const r of db.rules) {
    files[`기준/공지-${r.no}.md`] = [`# 공지 ${r.no}. ${r.title}`, `문서번호 ${r.docNo} · 시행일 ${r.effective} · 규칙 유형 ${r.type}`, '', r.summary, '',
      ...(r.codes.length ? ['대상 코드: ' + r.codes.join(', ')] : []), ...(r.keywords.length ? ['대상 품목: ' + r.keywords.join(', ')] : []),
      ...(r.maxPerOp != null ? [`수술 1회당 한도: ${r.maxPerOp}`] : []), ...(r.pct != null ? [`금액 변동: ${r.pct}%`] : [])].join('\n');
  }
  // 수술 (기록 + 청구 요약)
  for (const r of Object.values(db.records)) {
    const c = db.claims[r.op];
    files[opPath(r)] = [
      `# ${r.op} · ${r.date}`, `${r.surgeon} · ${r.opName}`, r.setCode ? `세트 [[${setPath(r.setCode)}]]` : '', '',
      '## 기록지에 적힌 재료', ...r.lines.map(l => `- "${l.rawName}" ${l.rawSpec} × ${l.qty} → ${l.code ? `${l.code} ${M[l.code].spec} [[${famPath(l.family)}]]` : '코드 미확정'}`), '',
      `## 청구 목록`, c ? `${c.lines.length}줄 · 합계 ${won(c.lines.reduce((s, l) => s + l.amount, 0))}` : '청구 없음',
    ].filter(x => x !== '').join('\n');
  }
  files['README.md'] = [`# 우리 병원 Knowledge Base · Loop DB v${db.version}`, '', `재료 ${usedFams.size}군 · 세트 ${Object.keys(db.sets).length}개 · 집도의 ${new Set(Object.values(db.sets).map(s => s.surgeon)).size}명 · 기준 ${db.rules.length}건 · 수술 ${Object.keys(db.records).length}건`, '',
    '## 버전 이력', ...db.changelog.map(c => `- v${c.version} · ${c.reason} · 수술 +${c.addedOps ?? 0}건 · 별칭 +${c.newAliases ?? 0}종`)].join('\n');
  return files;
}
