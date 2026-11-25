// 파일 판독기: 바이트 → 텍스트/표. 브라우저와 Node 양쪽에서 동작한다.
// pdfjs, fflate 는 호출하는 쪽에서 넣어 준다(브라우저: vendor, Node: 같은 파일).

export function decodeText(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('euc-kr').decode(u8);
  }
}

// RFC4180 CSV 파서 (따옴표·줄바꿈 포함 셀 처리)
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

// 머리글 행을 찾아(상위 10행 중 채워진 칸이 가장 많은 행) 객체 배열로 바꾼다.
export function tableToObjects(rows) {
  let hi = 0, best = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const filled = rows[i].filter(c => c && isNaN(Number(c))).length;
    if (filled > best) { best = filled; hi = i; }
  }
  const header = rows[hi].map(h => h.trim());
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const o = {};
    header.forEach((h, j) => { if (h) o[h] = (rows[i][j] ?? '').trim(); });
    out.push(o);
  }
  return { header, headerRow: hi + 1, rows: out };
}

// PDF → 줄 단위 텍스트. 같은 높이의 글자를 한 줄로 묶고, 칸 사이가 벌어지면 ' | ' 로 나눈다.
export async function pdfToLines(buf, pdfjs) {
  const data = new Uint8Array(buf.byteLength ?? buf.length);
  data.set(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str && it.str.trim() !== '')
      .map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    // 1) 같은 높이의 글자를 한 줄로, 벌어진 곳에서 칸을 나눈다. 칸마다 가로 위치를 기억한다.
    const rows = [];
    let cur = [], cy = null;
    const flush = () => {
      if (!cur.length) return;
      cur.sort((a, b) => a.x - b.x);
      const cells = [];
      let prevEnd = null;
      for (const it of cur) {
        const gap = prevEnd === null ? Infinity : it.x - prevEnd;
        if (gap > 9) cells.push({ x: Math.round(it.x), s: it.s });
        else cells[cells.length - 1].s += (gap > 1.2 ? ' ' : '') + it.s;
        prevEnd = it.x + it.w;
      }
      rows.push(cells);
      cur = [];
    };
    for (const it of items) {
      if (cy === null || Math.abs(it.y - cy) > 2.5) { flush(); cy = it.y; }
      cur.push(it);
    }
    flush();
    // 2) 칸 안에서 줄이 넘어간 글자를 제자리에 잇는다.
    //    칸이 하나뿐이고, 왼쪽 여백이 아닌 곳에서 시작하며, 윗줄의 어느 칸과 가로 위치가 같으면 그 칸의 이어진 글자다.
    const margin = Math.min(...rows.flat().map(c => c.x));
    const merged = [];
    for (const cells of rows) {
      const prev = merged[merged.length - 1];
      if (prev && cells.length === 1 && cells[0].x > margin + 5) {
        const host = prev.find(c => Math.abs(c.x - cells[0].x) <= 3);
        if (host && prev.length > 1) { host.s += ' ' + cells[0].s; continue; }
      }
      merged.push(cells.map(c => ({ ...c })));
    }
    // 3) 구획(번호가 붙은 항목)마다 열 위치를 모아, 빈 칸을 ∅ 로 채운다. 줄마다 칸 수가 같아져 열이 밀리지 않는다.
    const isStarter = cells => cells[0].x <= margin + 5 && /^(\d+\.|[A-Z]\.)(\s|$)/.test(cells[0].s);
    const blocks = [];
    for (const cells of merged) {
      if (!blocks.length || isStarter(cells)) blocks.push([]);
      blocks[blocks.length - 1].push(cells);
    }
    const clean = t => t.replace(/\s+/g, ' ').trim();
    for (const block of blocks) {
      const xs = [...new Set(block.flat().map(c => c.x))].sort((a, b) => a - b);
      const cols = [];
      for (const x of xs) { if (!cols.length || x - cols[cols.length - 1].max > 30) cols.push({ min: x, max: x }); else cols[cols.length - 1].max = x; }
      const tabular = block.filter(c => c.length >= 3).length >= 2 && cols.length >= 3;
      for (const cells of block) {
        if (!tabular || cells.length < 2) { lines.push(cells.map(c => clean(c.s)).join(' | ')); continue; }
        const row = cols.map(() => '∅');
        for (const c of cells) {
          const k = cols.findIndex(col => c.x >= col.min - 1 && c.x <= col.max + 1);
          row[k] = row[k] === '∅' ? clean(c.s) : row[k] + ' ' + clean(c.s);
        }
        lines.push(row.join(' | '));
      }
    }
  }
  await doc.destroy();
  return lines;
}

// DOCX → 줄 단위 텍스트. 표는 행마다 칸을 ' | ' 로 잇는다.
export function docxToLines(buf, unzipSync) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const files = unzipSync(u8, { filter: f => f.name === 'word/document.xml' });
  const xml = new TextDecoder().decode(files['word/document.xml']);
  const body = xml.slice(xml.indexOf('<w:body'));
  const lines = [];
  const textOf = frag => {
    const paras = frag.split(/<\/w:p>/).map(p =>
      [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map(m => m[1] ?? ' ').join(''));
    return paras.map(s => s.trim()).filter(Boolean).join(' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  };
  // 표와 표 밖 문단을 문서 순서대로 훑는다
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>/g;
  let last = 0, m;
  const pushParas = frag => frag.split(/<\/w:p>/).forEach(p => { const t = textOf(p + '</w:p>'); if (t) lines.push(t); });
  while ((m = re.exec(body))) {
    pushParas(body.slice(last, m.index));
    for (const tr of m[1].split(/<\/w:tr>/)) {
      const cells = tr.split(/<\/w:tc>/).slice(0, -1).map(textOf).map(c => c === '' ? '∅' : c);
      if (cells.length) lines.push(cells.join(' | '));
    }
    last = re.lastIndex;
  }
  pushParas(body.slice(last));
  return lines;
}

// XLSX → 행 배열 (첫 시트). 공유 문자열과 인라인 문자열만 처리한다.
export function xlsxToRows(buf, unzipSync) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const files = unzipSync(u8, { filter: f => /^xl\/(sharedStrings\.xml|worksheets\/sheet1\.xml)$/.test(f.name) });
  const dec = n => files[n] ? new TextDecoder().decode(files[n]) : '';
  const un = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const shared = [...dec('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => un([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(x => x[1]).join('')));
  const rows = [];
  for (const rm of dec('xl/worksheets/sheet1.xml').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\s+r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      let col = 0; for (const ch of cm[1]) col = col * 26 + ch.charCodeAt(0) - 64;
      const t = /t="(\w+)"/.exec(cm[2])?.[1];
      const v = /<v>([^<]*)<\/v>/.exec(cm[3] || '')?.[1] ?? /<t[^>]*>([^<]*)<\/t>/.exec(cm[3] || '')?.[1] ?? '';
      row[col - 1] = t === 's' ? shared[Number(v)] : un(v);
    }
    rows.push(Array.from(row, c => c ?? ''));
  }
  return rows.filter(r => r.some(c => c !== ''));
}

export async function sha1(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
