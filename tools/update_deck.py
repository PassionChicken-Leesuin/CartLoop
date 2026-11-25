# -*- coding: utf-8 -*-
"""발표 자료를 현재 서비스에 맞춘다: 화면 그림 교체 + 화면과 어긋나는 숫자 · 자리표시 정리.

  python tools/update_deck.py <원본 pptx> <결과 pptx> <캡처 폴더>

원본은 건드리지 않고 결과 파일을 새로 쓴다. 바꾼 내용은 모두 화면에 출력한다.
"""
import io, os, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from pptx import Presentation
from pptx.util import Emu
from PIL import Image

PT = 12700
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
IMAGES = {  # 슬라이드 → [(그림 이름, 캡처)]
    18: [('Picture 27', '18-left-upload'), ('Picture 31', '18-right-result')],
    19: [('Picture 27', '19-left-ehr'), ('Picture 31', '19-right-assist')],
    20: [('Picture 27', '20-left-evidence'), ('Picture 31', '20-right-proposal')],
    21: [('Picture 27', '21-left-ask'), ('Picture 30', '21-right-update')],
    22: [('입력 화면 (파일 업로드)', '18-left-upload'), ('출력 화면 ① 청구 대조 알림', '19-right-assist'), ('출력 화면 ② 세트 개정안', '20-right-proposal')],
    23: [('그림 97', '23-desktop')],
}
TEXTS = {  # 슬라이드 → [(도형 이름, 옛 글의 일부, 새 글)]
    18: [('TextBox 35', 'xlsx 원본', '파일 이름이 아니라 머리글과 열의 뜻으로 판별. PDF · DOCX 기록지는 서식 항목으로 판별'),
         ('TextBox 38', '980종', '표기 470종 → 89개 코드'),
         ('TextBox 43', '126개', '지난 기록에서 확인할 항목 43개 · 빠진 금액 추정 432만 원 (가상 금액)')],
    19: [('TextBox 35', '기록 6줄', '기록 8줄 · 청구 41줄. EHR DB에는 접근하지 않음'),
         ('TextBox 39', '314BBM02', '"Cresent cage 30mm H14" → F1757850. 청구 목록에 없으면 누락, 수량이 다르면 불일치')],
    21: [('TextBox 29', '3개월 v3', 'Loop DB 갱신 — 설치 때 v1 → 3개월 뒤 v4'),
         ('TextBox 38', '+117건', '수술 +101건, 새 표기 +78종. 사람이 입력한 것 없음')],
}
# 14 · 15 · 16 · 17장: 실제 구현 내용 (도형 이름이 겹치므로 옛 글의 일부로 찾는다)
TEXTS.update({
    14: [(None, '[사용 모델 입력]', 'Claude Haiku 5.5 (추출 · 별칭) · Sonnet 5.5 (규칙 · 답변)'),
         (None, '[프레임워크 · 오케스트레이션 방식 입력]', '프레임워크 없이 직접 구현 · 에이전트 5개 · 20건 동시 호출'),
         (None, '파일시스템 기반 · 파일과 링크로 저장', 'Loop DB(JSON) · 파일과 링크 구조로 열람'),
         (None, '병원 전용 프라이빗 클라우드 (로컬 LLM)', '베타: 웹(Vercel) + 외부 LLM API · 목표: 병원 전용 클라우드')],
    15: [('TextBox 33', 'ACDF', '12종 (TLIF · PLIF · MED · TKA · THA · ARCR · RTSA 등)'),
         ('TextBox 35', '118건', '2023.01~2025.12 청구 3년치 · 마지막 3개월 101건은 설치 후 EHR 화면용'),
         ('TextBox 37', '119건', '심은 오류 53건 · 세트 어긋남 2곳 · 기록 줄 1,699개의 정답 코드')],
    16: [('TextBox 39', '술식 5종', '집도의 6명 × 술식 12종의 선호를 정해 3년치 1,240건을 만들고, 오류를 심은 뒤 정답지를 따로 보관'),
         ('TextBox 47', 'xlsx · csv · txt', 'pdf · docx · csv · txt를 읽어 머리글 위치와 열의 뜻, 서식 항목으로 파일 종류를 스스로 판별')],
    17: [(None, '(XLSX · CSV · PDF · HWP)', '파일 업로드 (CSV · XLSX · PDF · DOCX · TXT)'),
         (None, '심평원 재료코드에 매핑', '병원 재료 마스터의 재료코드에 매핑'),
         (None, '[파일 파서 · 문서 읽기 방식]', '브라우저에서 pdf.js와 자체 판독기로 읽음. PDF 표는 글자 위치로 열을 맞추고 빈 칸을 채움'),
         (None, '[추출 에이전트: 모델 · 프롬프트 · 출력 형식]', 'Claude Haiku 5.5 · 기록지 1건당 1회 호출 · 정해진 JSON 형식으로 출력'),
         (None, '[별칭 통합 방법: 규칙 · 임베딩 · LLM]', '코드가 적힌 줄에서 먼저 학습 → LLM이 품목군 제안 → 같은 수술의 청구 목록으로 검증. 규격은 숫자 대조 규칙'),
         (None, '[KB 폴더 · 링크 구조, 갱신 조건]', 'Loop DB(JSON)에 별칭 · 세트 · 규칙 · 수술 저장. 수술 1건마다 반영, 한 달분을 읽으면 정리 후 버전 올림'),
         (None, '[대조 로직 · 알림 기준 · 개정안 조건]', '판정은 규칙 기반 (LLM 미사용). 개정안은 임플란트 10건 중 8건, 소모품 20건 중 17건 기준')],
})
# 15장 표: (첫 칸에 들어 있는 말, [새 칸 글 ...])  None 은 그대로 둔다
TABLE_15 = [
    ('수술간호기록지', ['수술간호기록지  pdf · docx', '415건 (2025년) · 재료 1,417줄', '심평원 표준서식 17. 치료재료 · 삽입관 칸의 자유 텍스트. 재료코드 93개가 548가지 표기로 적힘 (한글 별칭, 약어, 오타)']),
    ('치료재료 청구목록', [None, '42,861줄 · 수술 1,240건 · 수술당 39줄 안팎', '병원 재료코드, 품명, 규격, 수량, 단가, 급여구분. 기록지와 표기가 다름']),
    ('재료 마스터', ['재료 마스터  csv', None, None]),
    ('Case cart 세트 목록', ['Case cart 세트 목록  csv', '18세트 · 504줄', '집도의 · 술식별 세트와 버전. 한 세트의 두 품목은 실제 사용과 어긋나 있음']),
    ('기준 변경 공지', [None, None, '시행일이 있는 산정 불가 · 정액 포함 · 수량 한도 · 단가 조정 · 사용 중지 · 세트 개정 기준 안내']),
]
RUN_EDITS = {15: [('생성 시드를 고정해 같은 데이터를 언제든 다시 만들 수 있음', '정답지는 생성 스크립트로 언제든 같은 결과를 다시 만들 수 있음')]}
RESULTS_25 = ['99.99 %', '100 %', '0 %']
TABLE_25 = {'A-1': '99.99% (10,415 / 10,416 필드)', 'A-2': '표기 100% (547 / 547) · 줄 100% (1,699 / 1,699)', 'A-3': '100% (504 / 504 항목)',
            'B-1': '재현율 100% (30 / 30) · 정밀도 100%', 'B-2': '100% (23 / 23) · 오탐 0건', 'B-3': '제안 3건 모두 정답과 일치 (설치 시점 2 · 3개월 뒤 1)'}
NOTE_25 = '시험 재료: 가상 수술 1,240건(청구 42,861줄) · 수술간호기록지 415건 · 재료 마스터 312품목 · 심어 둔 오류 53건.  정답지와 서비스를 같은 팀이 만들어 맞춘 결과이며, 독립 검증은 아님'

def set_text(tf, text):
    # 첫 문단 · 첫 글자 묶음의 서식을 그대로 두고 글만 바꾼다
    p0 = tf.paragraphs[0]
    for p in tf.paragraphs[1:]: p._p.getparent().remove(p._p)
    runs = p0.runs
    if not runs: p0.text = text; return
    runs[0].text = text
    for r in runs[1:]: r._r.getparent().remove(r._r)

def main(src, dst, shots):
    prs = Presentation(src)
    for no, items in IMAGES.items():
        slide = prs.slides[no - 1]
        for name, shot in items:
            pic = next((s for s in slide.shapes if s.name == name and s.shape_type == 13), None)
            img = os.path.join(shots, shot + '.png')
            if pic is None or not os.path.exists(img): print(f'!! {no}장 {name}: 찾지 못함'); continue
            w, h = Image.open(img).size
            scale = min(pic.width / w, pic.height / h)
            nw, nh = int(w * scale), int(h * scale)
            _, rid = slide.part.get_or_add_image_part(img)
            bf = pic._element.blipFill; bf.blip.rEmbed = rid
            src_rect = bf.find(A + 'srcRect')
            if src_rect is not None: bf.remove(src_rect)
            pic.left = Emu(pic.left + (pic.width - nw) // 2); pic.width, pic.height = Emu(nw), Emu(nh)
            print(f'{no}장 그림 {name} ← {shot}.png ({nw // PT}x{nh // PT}pt)')
    for no, items in TEXTS.items():
        slide = prs.slides[no - 1]
        for name, part, new in items:
            sh = next((s for s in slide.shapes if (name is None or s.name == name) and s.has_text_frame and part in s.text_frame.text), None)
            if sh is None: print(f'!! {no}장 {name}: "{part}" 글을 찾지 못함'); continue
            old = sh.text_frame.text.replace('\n', ' '); set_text(sh.text_frame, new)
            print(f'{no}장 글 "{old}" → "{new}"')
    # 15장 표
    for sh in prs.slides[14].shapes:
        if sh.shape_type != 19: continue
        for row in sh.table.rows:
            head = row.cells[0].text_frame.text
            for key, cells in TABLE_15:
                if key in head:
                    for c, txt in zip(row.cells, cells):
                        if txt is not None: set_text(c.text_frame, txt)
                    print(f'15장 표 {key}: ' + ' | '.join(t or '(그대로)' for t in cells)[:120])
    # 글자 묶음 안에서만 바꾸기 (앞의 굵은 머리말 서식을 지키려고)
    for no, items in RUN_EDITS.items():
        for sh in prs.slides[no - 1].shapes:
            if not sh.has_text_frame: continue
            for para in sh.text_frame.paragraphs:
                for run in para.runs:
                    for a, b in items:
                        if a in run.text: run.text = run.text.replace(a, b); print(f'{no}장 글 "{a}" → "{b}"')
    # 14~17장의 "구축된 서비스 바탕으로 수정" 상자와 "작성 필요" 표시
    for no in range(14, 18):
        slide = prs.slides[no - 1]
        for sh in list(slide.shapes):
            if sh.has_text_frame and (sh.text_frame.text.strip() == '구축된 서비스 바탕으로 수정' or sh.name == 'TODO marker'):
                print(f'{no}장 지움: {sh.name} "{sh.text_frame.text.strip()}"'); sh._element.getparent().remove(sh._element)
    # 자리표시 지우기: 빨간 "예시" 상자, "실제 구현 화면 캡처로 교체 가능" 표시, 23장의 겹치는 로고
    for no in range(18, 23):
        slide = prs.slides[no - 1]
        for sh in list(slide.shapes):
            if sh.has_text_frame and sh.text_frame.text.strip() == '예시' or sh.name == 'TODO marker':
                print(f'{no}장 지움: {sh.name} "{sh.text_frame.text.strip()}"'); sh._element.getparent().remove(sh._element)
    s23 = prs.slides[22]
    for sh in list(s23.shapes):
        if sh.shape_type == 13 and sh.name != '그림 97': print(f'23장 지움: {sh.name} (화면 그림 위에 겹치는 로고)'); sh._element.getparent().remove(sh._element)
    # 25장: 측정값
    s25 = prs.slides[24]
    todo = sorted([s for s in s25.shapes if s.name == 'result TODO'], key=lambda s: s.left)
    for sh, v in zip(todo, RESULTS_25): set_text(sh.text_frame, v); print(f'25장 값 {v}')
    for sh in s25.shapes:
        if sh.shape_type == 19:
            for row in sh.table.rows:
                key = row.cells[0].text_frame.text.strip()
                if key in TABLE_25: set_text(row.cells[len(row.cells) - 1].text_frame, TABLE_25[key]); print(f'25장 표 {key}: {TABLE_25[key]}')
        elif sh.has_text_frame and sh.text_frame.text.startswith('시험 재료'):
            set_text(sh.text_frame, NOTE_25); print('25장 각주 수정')
    prs.save(dst); print('저장:', os.path.basename(dst))

if __name__ == '__main__':
    main(*sys.argv[1:4])
