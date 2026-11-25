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
            sh = next((s for s in slide.shapes if s.name == name and s.has_text_frame and part in s.text_frame.text), None)
            if sh is None: print(f'!! {no}장 {name}: "{part}" 글을 찾지 못함'); continue
            old = sh.text_frame.text.replace('\n', ' '); set_text(sh.text_frame, new)
            print(f'{no}장 글 "{old}" → "{new}"')
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
