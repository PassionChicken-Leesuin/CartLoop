# -*- coding: utf-8 -*-
"""CartLoop 정답지 생성기.

가상 데이터 셋을 서비스와 다른 방법으로 읽어 정답지를 만든다.
  - 기록지: pdfplumber / python-docx 로 표를 칸 단위로 읽는다 (서비스는 글자 줄 + LLM 추출).
  - 표기 → 재료코드: 사람이 정리한 호칭 규칙표(NAME2FAM)와 품목군별 규격 해석기로 잇는다
    (서비스는 LLM 제안 + 기록↔청구 짝 검증).
  - 오류: 기록지와 청구 목록의 차이, 공지 규칙 위반을 유형별로 적는다.
  - 세트 어긋남: 공지 6의 기준(임플란트 10건 중 8건, 소모품 20건 중 17건)을 그대로 적용한다.

실행:  python tools/build_answer_key.py
출력:  정답지/*.csv (사람이 보는 표) · cartloop/answer/answer_key.json (채점 화면이 읽는 파일)
같은 데이터면 언제 돌려도 같은 정답지가 나온다(난수 없음).
"""
import io, sys, os, re, csv, json, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import pdfplumber, docx

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
D = os.path.join(ROOT, '가상 데이터 셋')
OUT = os.path.join(ROOT, '정답지')
APP_OUT = os.path.join(ROOT, 'cartloop', 'answer')
INSTALL_DATE = '2025-10-01'
C = collections.Counter

def read_csv(name):
    return list(csv.DictReader(open(os.path.join(D, name), encoding='utf-8-sig')))

# ───────────── 기록지 읽기 (칸 단위) ─────────────
def pdf_rows(p):
    rows = []
    with pdfplumber.open(p) as pdf:
        for pg in pdf.pages:
            for t in pg.extract_tables():
                for r in t: rows.append([(c or '').replace('\n', ' ').strip() for c in r])
    return rows

def docx_rows(p):
    d = docx.Document(p); rows = []
    for t in d.tables:
        for r in t.rows:
            cells = []; seen = set()
            for c in r.cells:
                if id(c._tc) in seen: continue
                seen.add(id(c._tc)); cells.append(c.text.replace('\n', ' ').strip())
            rows.append(cells)
    return rows

def parse_record(fname, rs):
    pdf = fname.endswith('.pdf')
    R = {'op': fname.split('.')[0], 'file': fname, 'materials': [], 'drains': [], 'note': ''}
    sec = None
    def vals(r): return [x for x in r if x != '']
    for r in rs:
        first = r[0]; c = vals(r)
        if first.startswith('환자 등록번호'): R['pid'] = c[1]
        elif first.startswith('3. 수술 시작일시'): R['date'] = c[1][:10]
        elif first.startswith('5. 소독'): R['scrub'] = c[1]; R['circ'] = c[3] if len(c) > 3 else ''
        elif first.startswith('1. 수술부위'): R['site'] = c[-1]; sec = None
        elif first.startswith('2. 수술 전'): sec = None
        elif first.startswith('3. 수술 후'): sec = 'dx'
        elif first.startswith('4. 수술명'): sec = 'opname'
        elif first.startswith('1. 삽입관'): sec = 'drain'
        elif first.startswith('2. 치료재료'): sec = 'mat'
        elif first.startswith('3. 수술 중'): sec = 'drug'
        elif first.startswith('4. 검체'): sec = 'spec'
        elif first.startswith('5. 사용장비'): sec = None
        elif first.startswith('6. 중요'): sec = None; R['note'] = c[-1] if len(c) > 1 else ''
        elif first.startswith('E.'): sec = 'E'
        elif first.startswith(('A.', 'B.', 'C.', 'D.')): sec = None
        body = [x for x in r[1:] if x != ''] if pdf else r[1:]
        if sec == 'mat':
            if '재료명' in r: continue
            if pdf: code, name, spec, qty, unit = r[1], r[4], r[6], r[8], r[11]
            else: code, name, spec, qty, unit = (r[1:] + [''] * 5)[:5]
            if name or spec: R['materials'].append({'code': code, 'name': name, 'spec': spec, 'qty': int(qty or 1), 'unit': unit})
        elif sec == 'drain':
            if '종류' in r: continue
            b = [x for x in body if x != '']
            if b: R['drains'].append({'type': b[0], 'note': b[1] if len(b) > 1 else ''})
        elif sec == 'opname':
            if '수가코드' in r: continue
            b = [x for x in body if x != '']
            if b: R['opName'] = b[0]; R['opCode'] = b[-1]
        elif sec == 'dx':
            if '상병분류기호' in r: continue
            b = [x for x in body if x != '']
            if b: R['diagnosis'] = b[0]
        elif sec == 'E':
            x = [v for v in r if v]
            if 'SURG' in r: R['surgeon'] = x[-1]
            if 'DEPT' in r: R['dept'] = x[-1]
            if 'ROOM' in r: R['room'] = x[-1]
    return R

# ───────────── 표기 → 재료코드 (사람이 정리한 규칙) ─────────────
FAM = {
 'SCREW': 'LNK SPINAL FIXATION SYSTEM SCREW SET', 'SETSCREW': 'LNK SPINAL FIXATION SYSTEM SET SCREW', 'ROD': 'LNK SPINAL FIXATION SYSTEM ROD',
 'CRESCENT': 'CRESCENT TITANIUM', 'PEEKCAGE': 'PLIF PEEK CAGE', 'BMP': 'BMP2', 'COLLASTAT': 'COLLASTAT', 'SEALANT': 'DURAL SEALANT',
 'PVPKIT': 'VERTEBROPLASTY BONE CEMENT KIT', 'PVPNEEDLE': 'VERTEBROPLASTY NEEDLE', 'CEMENT': 'BONE CEMENT 40g',
 'TKAFEM': '슬관절전치환용 FEMORAL', 'TKATIB': '슬관절전치환용 TIBIAL', 'TKAINS': '슬관절전치환용 BEARING',
 'STEM': '고관절치환용 FEMORAL COMPONENT', 'CUP': '고관절치환용 ACETABULAR', 'LINER': '고관절치환용 LINER', 'HEAD': '고관절치환용 FEMORAL HEAD',
 'RTSA': 'TOTAL SHOULDER PROSTHESIS', 'PEEKSA': 'PEEK SUTURE ANCHOR', 'ALLSA': 'ALL-SUTURE ANCHOR', 'KNOTLESS': 'KNOTLESS PEEK ANCHOR',
 'PLATE': 'SMALL LOCKING ANATOMICAL PLATE', 'LS24': 'LOCKING SCREW 2.4', 'CCS': 'CANNULATED SCREW',
 'HEMOVAC': 'HEMOVAC PP', 'JP': 'JACKSON-PRATT'}
NAME2FAM = [
 (r'^(set sc(r)?ew|locking cap|lnk cap|잠금나사)$', 'SETSCREW'),
 (r'^(2\.4 locking|locking screw|ls 2\.4)$', 'LS24'),
 (r'^(cann\. screw|cannulated screw|ccs|유관나사)$', 'CCS'),
 (r'(rod|로드)$', 'ROD'),
 (r'(screw|나사|accelfix poly)$', 'SCREW'),
 (r'^(crescent|cresent|크레센트)', 'CRESCENT'),
 (r'^(peek cage|plif cage|plif peek|피크 케이지)$', 'PEEKCAGE'),
 (r'bmp', 'BMP'), (r'collastat|콜라스탯', 'COLLASTAT'), (r'sealant|실란트', 'SEALANT'),
 (r'^(bone cement kit|pmma kit|pvp cement kit|시멘트 키트)$', 'PVPKIT'),
 (r'needle|바늘', 'PVPNEEDLE'),
 (r'^(bone cement|cement|pmma cement|골시멘트)$', 'CEMENT'),
 (r'^(fem cr|femoral comp|femoral component cr|tka femur|대퇴 컴포넌트)$', 'TKAFEM'),
 (r'^(tib|tibial baseplate|tibial comp|tka tibia|경골 컴포넌트)$', 'TKATIB'),
 (r'insert$', 'TKAINS'),
 (r'stem$', 'STEM'), (r'^(acetabular cup|cup|shell)$', 'CUP'), (r'liner$', 'LINER'), (r'head$', 'HEAD'),
 (r'^(glenosphere|reverse shoulder|rtsa set)$', 'RTSA'),
 (r'^(all-suture anchor|soft anchor|올서쳐 앵커)$', 'ALLSA'),
 (r'^(knotless anchor|knotless peek|노트리스 앵커)$', 'KNOTLESS'),
 (r'^(peek anchor|peek sa|suture anchor|앵커)$', 'PEEKSA'),
 (r'plate$', 'PLATE'),
 (r'hemovac|헤모박', 'HEMOVAC'), (r'jackson|jp drain', 'JP'),
]
def base(n): return re.sub(r'\s+', ' ', re.sub(r'\s*\(.*$', '', n)).strip().lower()
def fam_of(name):
    b = base(name)
    for pat, f in NAME2FAM:
        if re.search(pat, b): return f
    return None
def nums(s): return [float(x) for x in re.findall(r'\d+(?:\.\d+)?', s)]
def spec_key(fam, spec):
    s = spec.lower().replace('×', 'x').replace('*', 'x'); n = nums(s)
    if fam == 'SETSCREW': return '-'
    if fam == 'SCREW': return (n[0], n[1]) if len(n) >= 2 else None
    if fam == 'ROD': return n[-1] if n else None
    if fam == 'CRESCENT':
        m = re.search(r'h\s*(\d+)', s); L = re.search(r'(26|30)', s)
        if m: return (float(L.group(1)) if L else None, float(m.group(1)))
        return (n[0], n[2]) if len(n) >= 3 else None
    if fam == 'PEEKCAGE': return n[-1] if n else None
    if fam in ('BMP', 'COLLASTAT', 'SEALANT'): return n[0] if n else None
    if fam == 'PVPKIT': return 20.0
    if fam == 'CEMENT': return 40.0
    if fam == 'PVPNEEDLE': return n[0] if n else None
    if fam in ('TKAFEM', 'TKATIB', 'STEM'): return n[0] if n else None
    if fam == 'TKAINS':
        m = re.search(r'(3-4|5-6)', s); t = re.findall(r'\d+', s.replace('3-4', '').replace('5-6', ''))
        return (m.group(1), float(t[0])) if m and t else None
    if fam in ('CUP', 'LINER', 'HEAD', 'RTSA', 'PEEKSA', 'ALLSA', 'KNOTLESS'): return n[0] if n else None
    if fam == 'PLATE': return 'standard' if s.strip() in ('standard', 'std') else s.strip()
    if fam in ('LS24', 'CCS'): return n[-1] if n else None
    if fam == 'HEMOVAC': return n[0] if n else None
    if fam == 'JP': return 100.0
    return None

def main():
    mast = read_csv('재료마스터_품목표.csv'); claims = read_csv('치료재료_청구목록_2023-2025.csv'); sets = read_csv('CaseCart_세트목록.csv')
    M = {m['재료코드']: m for m in mast}
    idx = collections.defaultdict(dict); code2fam = {}
    for m in mast:
        for f, p in FAM.items():
            if m['품명'].startswith(p):
                if f == 'HEMOVAC' and '800' in m['품명']: continue
                k = nums(m['품명'])[0] if f == 'HEMOVAC' else spec_key(f, m['규격'])
                idx[f][k] = m['재료코드']; code2fam[m['재료코드']] = f
    byop = collections.defaultdict(list)
    for c in claims: byop[c['수술번호']].append(c)
    opdate = {op: cl[0]['수술일'] for op, cl in byop.items()}
    def cq(op):
        q = C()
        for c in byop[op]: q[c['재료코드']] += int(c['수량'])
        return q

    # 기록지
    rdir = os.path.join(D, '수술간호기록_2025')
    recs = {}
    files = sorted(os.listdir(rdir))
    for i, f in enumerate(files):
        p = os.path.join(rdir, f)
        recs[f.split('.')[0]] = parse_record(f, pdf_rows(p) if f.endswith('.pdf') else docx_rows(p))
        if (i + 1) % 100 == 0: print('  기록지', i + 1, '/', len(files))

    def true_code(op, name, spec):
        f = fam_of(name)
        if not f: return None, None
        k = spec_key(f, spec)
        if f == 'CRESCENT' and k and k[0] is None:  # 길이 없이 높이만 적힌 케이지 → 같은 수술의 청구 목록으로 가린다
            cands = [c for kk, c in idx[f].items() if kk[1] == k[1]]
            hit = [c for c in cands if c in cq(op)]
            return (hit[0] if len(hit) == 1 else None), f
        return idx[f].get(k), f

    unresolved = 0
    for op, r in recs.items():
        for m in r['materials']:
            m['trueCode'], m['fam'] = true_code(op, m['name'], m['spec'])
            if m['code'] and m['trueCode'] and m['code'] != m['trueCode']: print('  ! 적힌 코드와 정답이 다름', op, m)
            if not m['trueCode']: unresolved += 1; print('  ! 미해결', op, m)
        for d in r['drains']:
            f = fam_of(d['type']); q = re.search(r'(\d+)\s*개', d['note'])
            d['qty'] = int(q.group(1)) if q else 1
            d['trueCode'] = idx[f].get(spec_key(f, d['note'].split(',')[0])) if f else None   # Foley 등은 대조 대상에서 뺀다
    print('기록지', len(recs), '건 · 재료 줄', sum(len(r['materials']) for r in recs.values()), '· 미해결', unresolved)

    # ───────── 오류 목록 ─────────
    errors = []
    def err(op, typ, code, **kw):
        m = M.get(code, {})
        errors.append({'op': op, 'date': opdate.get(op, ''), 'type': typ, 'code': code, 'name': m.get('품명', ''), 'spec': m.get('규격', ''),
                       'recQty': kw.get('rec', ''), 'claimQty': kw.get('claim', ''), 'otherCode': kw.get('other', ''), 'basis': kw.get('basis', '')})
    # A. 기록 ↔ 청구 (기록지가 있는 2025년 수술)
    for op, r in sorted(recs.items()):
        rq = C()
        for m in r['materials']:
            if m['trueCode']: rq[m['trueCode']] += m['qty']
        for d in r['drains']:
            if d['trueCode']: rq[d['trueCode']] += d['qty']
        q = cq(op)
        fams = collections.defaultdict(lambda: {'missing': [], 'extra': []})
        for code in set(rq) | {c for c in q if c in code2fam}:
            f = code2fam[code]
            if f == 'SETSCREW': continue   # 공지 1: 기록지에는 적어도 청구하지 않는다
            a, b = rq.get(code, 0), q.get(code, 0)
            if a > 0 and b == 0: fams[f]['missing'].append(code)
            elif a == 0 and b > 0: fams[f]['extra'].append(code)
            elif a != b: err(op, 'qty_mismatch', code, rec=a, claim=b, basis='기록지와 청구 수량이 다름')
        for f, g in fams.items():
            mi, ex = sorted(g['missing']), sorted(g['extra'])
            while mi and ex:
                x, y = mi.pop(0), ex.pop(0)
                err(op, 'spec_mismatch', x, rec=rq[x], claim=q[y], other=y, basis=f'기록 {M[x]["규격"]} · 청구 {M[y]["규격"]}')
            for x in mi: err(op, 'missing', x, rec=rq[x], claim=0, basis='기록지에 있으나 청구 목록에 없음')
            for y in ex: err(op, 'unrecorded', y, rec=0, claim=q[y], basis='청구 목록에 있으나 기록지에 없음')
    # B. 공지 규칙 (3년치 전체)
    for op in sorted(byop):
        q = cq(op); d = opdate[op]; lines = C(c['재료코드'] for c in byop[op]); price = {c['재료코드']: int(c['단가']) for c in byop[op]}
        for code in q:
            g = M[code]['급여구분']
            if g.startswith('정액 포함'):
                if d >= '2023-09-01': err(op, 'bundled', code, claim=q[code], basis='공지 2 (재료-2023-047)')
            elif g.startswith('산정불가'):
                if code != 'F1181580' or d >= '2023-03-02': err(op, 'non_billable', code, claim=q[code], basis='공지 1 (재료-2023-011)' if code == 'F1181580' else '재료 마스터 급여구분')
            if lines[code] > 1: err(op, 'duplicate', code, claim=q[code], basis=f'같은 코드 {lines[code]}줄')
            if M[code]['중분류코드'] == '060007' and code != 'F1181580' and d >= '2024-07-01' and price[code] != int(M[code]['상한금액']):
                err(op, 'price', code, claim=q[code], basis=f'공지 4 (재료-2024-031) · 청구 단가 {price[code]}')
        if d >= '2023-09-01' and q.get('N0327695', 0) > 1: err(op, 'bundle_dup', 'N0327695', claim=q['N0327695'], basis='공지 2 · 수술 1회당 1회')
        col = q.get('M1779797', 0) + q.get('M4282896', 0)
        if d >= '2024-01-15' and col > 2: err(op, 'qty_limit', 'M1779797' if q.get('M1779797') else 'M4282896', claim=col, basis='공지 3 (재료-2024-004) · 수술 1회당 2개')
        if d >= '2025-02-03' and q.get('M3371317', 0) > 0: err(op, 'discontinued', 'M3371317', claim=q['M3371317'], basis='공지 5 (재료-2025-006)')
    for i, e in enumerate(errors): e['id'] = f'E{i + 1:03d}'
    print('오류', len(errors), dict(C(e['type'] for e in errors)))

    # ───────── 세트 연결 · 세트 어긋남 ─────────
    def set_of(r):
        n = r['opName']; s = r['surgeon'][0]
        seg = (n.split(':')[1] if ':' in n else '').split('(')[0]
        lv = max(1, len(re.findall(r'\d+', seg)) - 1)
        for pre, tag in [('TLIF', f'TLIF{1 if lv <= 1 else 2}'), ('PLIF', 'PLIF2'), ('Laminectomy', 'LAM'), ('MED', 'MED'), ('Percutaneous', 'PVP'), ('TKA', 'TKA'),
                         ('THA', 'THA'), ('ARCR', 'ARCR'), ('RTSA', 'RTSA'), ('Arthroscopic', 'BANKART'), ('ORIF', 'DRF'), ('Internal', 'FNF')]:
            if n.startswith(pre): return f'SET-{s}-{tag}'
    S = collections.defaultdict(list)
    for s in sets: S[s['세트코드']].append(s)
    for r in recs.values(): r['setCode'] = set_of(r); assert r['setCode'] in S, r['opName']
    def rec_use(op):
        u = C()
        for m in recs[op]['materials'] + recs[op]['drains']:   # 삽입관(헤모박 등)도 기록지에 적힌 사용량이다
            if m['trueCode']: u[m['trueCode']] += m['qty']
        return u
    def drift(until):
        out = []
        for sk in sorted(S):
            rows = S[sk]; rev = rows[0]['개정일']
            ops = sorted([op for op, r in recs.items() if r['setCode'] == sk and rev < r['date'] < until], key=lambda o: (recs[o]['date'], o))
            trays = [r['재료명'].upper() for r in rows if r['재료코드'] == 'TRAY']
            setq = {r['재료코드']: int(r['수량']) for r in rows if r['재료코드'] != 'TRAY'}
            kind = {r['재료코드']: r['구분'] for r in rows}
            implant_fams = set(code2fam) - {c for c in code2fam if code2fam[c] in ('HEMOVAC', 'JP')}
            seen = set(setq)
            for o in ops[-20:]: seen |= set(cq(o))
            for o in ops[-10:]: seen |= set(rec_use(o))
            for c in sorted(seen):
                imp = ('임플란트' in kind[c]) if c in kind else (c in implant_fams)
                win, th = (10, 8) if imp else (20, 17)
                w = ops[-win:]
                if len(w) < th: continue
                use = [(rec_use(o) if imp else cq(o)).get(c, 0) for o in w]
                sq = setq.get(c, 0)
                more = sum(1 for u in use if u > sq); less = sum(1 for u in use if u < sq)
                if more < th and less < th: continue
                fam_name = re.sub(r'\s*\(.*$', '', M[c]['품명']).upper()
                tray = any(t.startswith(fam_name[:12]) or fam_name.startswith(t[:12]) for t in trays)
                if tray: continue   # 공지 6-4: 트레이(업체 대여) 품목은 업체와 협의
                if M[c]['급여구분'].startswith('산정불가') and sq == 0: continue
                zero = sum(1 for u in use if u == 0)
                action = ('add' if sq == 0 else 'qty') if more >= th else ('remove' if zero >= th else 'qty')
                picked = [u for u in use if (u > sq if more >= th else u < sq)]
                newq = 0 if action == 'remove' else max(C(picked).items(), key=lambda kv: (kv[1], kv[0]))[0]
                out.append({'setCode': sk, 'version': rows[0]['버전'], 'action': action, 'code': c, 'name': M[c]['품명'], 'spec': M[c]['규격'],
                            'kind': '임플란트' if imp else '소모품', 'setQty': sq, 'newQty': newq, 'hits': max(more, less), 'window': len(w)})
        return out
    drift_v1 = drift(INSTALL_DATE); drift_end = drift('9999-12-31')
    print('세트 어긋남 · 설치 시점', [(d['setCode'], d['action'], d['code']) for d in drift_v1])
    print('세트 어긋남 · 3개월 뒤', [(d['setCode'], d['action'], d['code']) for d in drift_end])

    # ───────── 저장 ─────────
    os.makedirs(OUT, exist_ok=True); os.makedirs(APP_OUT, exist_ok=True)
    def wcsv(name, rows, cols):
        with open(os.path.join(OUT, name), 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f); w.writerow(cols)
            for r in rows: w.writerow([r.get(c, '') for c in cols])
    TYPE_KO = {'missing': '청구 누락', 'qty_mismatch': '수량 불일치', 'spec_mismatch': '규격 불일치', 'unrecorded': '기록 없는 청구', 'non_billable': '산정 불가 품목 청구',
               'bundled': '정액 포함 품목 별도 청구', 'bundle_dup': '정액 중복 산정', 'qty_limit': '수량 한도 초과', 'price': '단가 미갱신', 'discontinued': '사용 중지 품목', 'duplicate': '같은 품목 중복 줄'}
    wcsv('정답_오류목록.csv', [{**e, '유형': TYPE_KO[e['type']]} for e in errors], ['id', 'op', 'date', '유형', 'type', 'code', 'name', 'spec', 'recQty', 'claimQty', 'otherCode', 'basis'])
    line_rows = []
    for op, r in sorted(recs.items()):
        for i, m in enumerate(r['materials']): line_rows.append({'op': op, 'date': r['date'], 'surgeon': r['surgeon'], '줄': i + 1, '구분': '치료재료', '적힌 재료명': m['name'], '적힌 규격': m['spec'], '수량': m['qty'], '적힌 코드': m['code'], '정답 코드': m['trueCode'], '정답 품명': M[m['trueCode']]['품명'] if m['trueCode'] else '', '정답 규격': M[m['trueCode']]['규격'] if m['trueCode'] else ''})
        for i, d in enumerate(r['drains']):
            if d['trueCode']: line_rows.append({'op': op, 'date': r['date'], 'surgeon': r['surgeon'], '줄': i + 1, '구분': '삽입관', '적힌 재료명': d['type'], '적힌 규격': d['note'], '수량': d['qty'], '적힌 코드': '', '정답 코드': d['trueCode'], '정답 품명': M[d['trueCode']]['품명'], '정답 규격': M[d['trueCode']]['규격']})
    wcsv('정답_기록줄_재료코드.csv', line_rows, ['op', 'date', 'surgeon', '줄', '구분', '적힌 재료명', '적힌 규격', '수량', '적힌 코드', '정답 코드', '정답 품명', '정답 규격'])
    wcsv('정답_세트어긋남.csv', [{**d, '시점': '설치 시점(2025-09-30까지)'} for d in drift_v1] + [{**d, '시점': '3개월 뒤(2025-12-31까지)'} for d in drift_end],
         ['시점', 'setCode', 'version', 'action', 'kind', 'code', 'name', 'spec', 'setQty', 'newQty', 'hits', 'window'])
    wcsv('정답_기록지_필드.csv', [{**r, '재료 줄 수': len(r['materials'])} for r in recs.values()], ['op', 'file', 'pid', 'date', 'surgeon', 'dept', 'room', 'site', 'diagnosis', 'opName', 'opCode', 'setCode', 'note', '재료 줄 수'])
    key = {'installDate': INSTALL_DATE, 'records': recs, 'errors': errors, 'setDrift': {'v1': drift_v1, 'end': drift_end},
           'counts': {'records': len(recs), 'materialLines': sum(len(r['materials']) for r in recs.values()), 'errors': len(errors), 'byType': dict(C(e['type'] for e in errors))}}
    json.dump(key, open(os.path.join(APP_OUT, 'answer_key.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    print('저장:', OUT, '·', os.path.join(APP_OUT, 'answer_key.json'))

if __name__ == '__main__':
    main()
