# -*- coding: utf-8 -*-
"""발표 자료의 화면 시안 이미지를 실제 서비스 캡처로 바꾼다.

  python tools/replace_deck_images.py <pptx> <캡처 폴더>

원본은 같은 폴더에 *_원본백업.pptx 로 한 번 복사해 둔다. 그림의 왼쪽 위 자리는 그대로 두고,
원래 그림이 차지하던 칸 안에 비율을 지켜 맞춘다(잘라내기 설정은 지운다).
"""
import io, os, shutil, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from pptx import Presentation
from pptx.util import Emu
from PIL import Image

# 슬라이드 번호 → [(그림 이름, 캡처 파일, 칸 아래로 더 써도 되는 높이 pt)]
PLAN = {
    18: [('Picture 27', '18-left-upload', 20), ('Picture 31', '18-right-result', 0)],
    19: [('Picture 27', '19-left-ehr', 0), ('Picture 31', '19-right-assist', 0)],
    20: [('Picture 27', '20-left-evidence', 0), ('Picture 31', '20-right-proposal', 0)],
    21: [('Picture 27', '21-left-ask', 0), ('Picture 30', '21-right-update', 0)],
    22: [('입력 화면 (파일 업로드)', '18-left-upload', 0), ('출력 화면 ① 청구 대조 알림', '19-right-assist', 0), ('출력 화면 ② 세트 개정안', '20-right-proposal', 0)],
    23: [('그림 97', '23-desktop', 0)],
}
PT = 12700

def main(path, shots):
    backup = path.replace('.pptx', '_원본백업.pptx')
    if not os.path.exists(backup):
        shutil.copy2(path, backup); print('백업:', os.path.basename(backup))
    prs = Presentation(path)
    for no, items in PLAN.items():
        slide = prs.slides[no - 1]
        for name, shot, extra in items:
            pic = next((s for s in slide.shapes if s.name == name and s.shape_type == 13), None)
            img = os.path.join(shots, shot + '.png')
            if pic is None or not os.path.exists(img):
                print(f'!! {no}장 {name}: 그림이나 캡처를 찾지 못함'); continue
            w, h = Image.open(img).size
            box_w, box_h = pic.width, pic.height + extra * PT
            scale = min(box_w / w, box_h / h)
            new_w, new_h = int(w * scale), int(h * scale)
            _, rid = slide.part.get_or_add_image_part(img)
            blip_fill = pic._element.blipFill
            blip_fill.blip.rEmbed = rid
            src = blip_fill.find('{http://schemas.openxmlformats.org/drawingml/2006/main}srcRect')
            if src is not None: blip_fill.remove(src)
            # 칸보다 좁아지면 칸 가운데에 둔다
            pic.left = Emu(pic.left + (pic.width - new_w) // 2)
            pic.width, pic.height = Emu(new_w), Emu(new_h)
            print(f'{no}장 {name} ← {shot}.png  {new_w // PT}x{new_h // PT}pt')
    prs.save(path)
    print('저장:', os.path.basename(path))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
