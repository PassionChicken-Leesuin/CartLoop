// 재료 묻기: 질문에서 집도의 · 술식 · 재료를 찾아 Loop DB에서 근거를 모은다. 답은 이 근거 안에서만 한다.
import { setOps, setPolicy } from './sets.js';

const won = n => (Number(n) || 0).toLocaleString('ko-KR') + '원';

export function findMentions(db, q) {
  const low = q.toLowerCase();
  const surgeons = [...new Set(Object.values(db.sets).map(s => s.surgeon))].filter(s => q.replace(/\s/g, '').includes(s.replace(/\s/g, '')));
  const procs = new Set();
  for (const s of Object.values(db.sets)) if (low.includes(s.procedure.toLowerCase())) procs.add(s.procedure);
  for (const [stem, proc] of Object.entries(db.procMap)) {
    const short = stem.split(/[ (,]/)[0].toLowerCase();
    if (short.length >= 3 && low.includes(short)) procs.add(proc);
  }
  const fams = new Set();
  for (const a of Object.values(db.aliases)) {
    if (!a.family) continue;
    if (a.key.length >= 2 && low.includes(a.key)) fams.add(a.family);
    else for (const w of a.key.split(/\s+/)) if (/[가-힣]/.test(w) && w.length >= 2 && low.includes(w)) fams.add(a.family);
  }
  for (const f of Object.values(db.families)) {
    for (const w of f.name.toLowerCase().split(/[^a-z가-힣]+/)) if (w.length >= 5 && low.includes(w)) fams.add(f.id);
  }
  const codes = (q.match(/[A-Z]\d{7}/g) || []).filter(c => db.master[c]);
  for (const c of codes) fams.add(db.master[c].family);
  const setCodes = (q.toUpperCase().match(/SET-[A-Z]-[A-Z0-9]+/g) || []).filter(c => db.sets[c]);
  return { surgeons, procs: [...procs], fams: [...fams], codes, setCodes };
}

function setBlock(db, s, focusFams) {
  const M = db.master;
  const ops = setOps(db, s.code);
  const all = Object.values(db.records).filter(r => r.setCode === s.code).sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op));
  const recent = all.slice(-10);
  const lines = [];
  lines.push(`■ 세트 ${s.code} · ${s.surgeon} · ${s.procedure} ${s.level} · ${s.version} (개정일 ${s.revised}) · 이 세트로 한 수술 ${all.length}건, 개정 뒤 ${ops.length}건`);
  const imp = s.items.filter(i => /임플란트/.test(i.kind));
  lines.push('  세트 임플란트: ' + (imp.map(i => i.code === 'TRAY' ? `[트레이] ${i.name} ${i.spec}` : `${i.name} ${i.spec} (${i.code}) ${i.qty}개`).join(' / ') || '없음'));
  lines.push(`  세트 소모품 ${s.items.filter(i => !/임플란트/.test(i.kind)).length}종`);
  // 최근 10건 임플란트 사용 (기록지 기준)
  const use = {};
  for (const r of recent) {
    const seen = {};
    for (const l of r.lines) if (l.code) seen[l.code] = (seen[l.code] || 0) + l.qty;
    for (const [c, q] of Object.entries(seen)) (use[c] ||= []).push({ op: r.op, q });
  }
  const rows = Object.entries(use).sort((a, b) => b[1].length - a[1].length);
  if (recent.length) {
    lines.push(`  최근 ${recent.length}건 기록지 사용 (${recent[0].date} ~ ${recent[recent.length - 1].date}):`);
    for (const [c, u] of rows) {
      if (focusFams.length && !focusFams.includes(M[c].family) && rows.length > 8) continue;
      const qs = u.map(x => x.q); const dist = {}; qs.forEach(q => dist[q] = (dist[q] || 0) + 1);
      lines.push(`   - ${M[c].name} ${M[c].spec} (${c}): ${recent.length}건 중 ${u.length}건 사용, 수량 ${Object.entries(dist).map(([q, n]) => `${q}개 ${n}건`).join(' · ')} [${u.slice(-3).map(x => x.op).join(', ')}]`);
    }
    const last = recent.slice(-3).reverse();
    lines.push('  가장 최근 수술의 기록지 표기: ' + last.map(r => `[${r.op} ${r.date}] ` + r.lines.filter(l => l.src === 'material').map(l => `${l.rawName} ${l.rawSpec} x${l.qty}`).join(', ')).join(' ║ '));
  }
  return lines.join('\n');
}

export function buildContext(db, question) {
  const m = findMentions(db, question);
  const M = db.master;
  const out = [];
  const sets = Object.values(db.sets);
  out.push(`[병원 개요] Loop DB v${db.version} · 수술기록 ${Object.keys(db.records).length}건 · 청구 ${Object.keys(db.claims).length}건 · 별칭 ${Object.keys(db.aliases).length}종`);
  out.push('집도의와 세트: ' + sets.map(s => `${s.surgeon} ${s.procedure} ${s.level}(${s.code} ${s.version})`).join(', '));

  let picked = sets.filter(s => m.setCodes.includes(s.code));
  if (!picked.length) picked = sets.filter(s => (!m.surgeons.length || m.surgeons.includes(s.surgeon)) && (!m.procs.length || m.procs.includes(s.procedure)) && (m.surgeons.length || m.procs.length));
  if (!picked.length && m.fams.length) {
    // 재료만 물었으면, 그 재료를 실제로 쓰는 세트를 찾는다
    const cnt = {};
    for (const r of Object.values(db.records)) if (r.setCode && r.lines.some(l => m.fams.includes(l.family))) cnt[r.setCode] = (cnt[r.setCode] || 0) + 1;
    picked = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => db.sets[c]).filter(Boolean);
  }
  // "2레벨"처럼 레벨을 말했으면 그 레벨의 세트를 앞에 둔다
  const lv = /(\d)\s*레벨/.exec(question);
  if (lv && picked.some(s => s.level.startsWith(lv[1]))) picked = [...picked.filter(s => s.level.startsWith(lv[1])), ...picked.filter(s => !s.level.startsWith(lv[1]))];
  for (const s of picked.slice(0, 5)) out.push(setBlock(db, s, m.fams));

  for (const f of m.fams.slice(0, 4)) {
    const fam = db.families[f]; if (!fam) continue;
    out.push(`■ 품목군 ${fam.name} (${fam.maker || '-'})`);
    out.push('  품목: ' + fam.codes.slice(0, 12).map(c => `${M[c].spec} ${c} ${won(M[c].cap)} ${M[c].benefit}`).join(' / '));
    const al = Object.values(db.aliases).filter(a => a.family === f);
    out.push('  현장 호칭: ' + al.map(a => `"${a.examples[0] || a.key}"(${a.n}회)`).join(', '));
    const st = db.famStat[f];
    if (st) out.push(`  기록지에 나온 수술 ${st.rec}건 · 청구된 수술 ${st.claim}건`);
  }
  if (db.rules.length) out.push('[기준 변경 공지]\n' + db.rules.map(r => `- 공지 ${r.no} (${r.docNo}, 시행 ${r.effective}) ${r.title}: ${r.summary}`).join('\n'));
  const P = setPolicy(db);
  out.push(`[세트 개정 기준] 임플란트 최근 ${P.implant.window}건 중 ${P.implant.min}건, 소모품 최근 ${P.consumable.window}건 중 ${P.consumable.min}건 이상 같은 방향으로 다르면 개정안`);
  return { context: out.join('\n').slice(0, 14000), mentions: m, sets: picked.map(s => s.code) };
}
