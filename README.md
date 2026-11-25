# CartLoop

우리 병원을 알아가는 청구 도우미. 병원에 이미 있는 파일(수술간호기록지, 청구 목록, 재료 마스터, Case cart 세트, 기준 변경 공지)을 올리면 병원 전용 Loop DB를 만들고, 수술기록과 청구 목록을 대조해 누락과 불일치를 알려 준다. EHR에는 연결하지 않는다.

베타 버전이며 환자 · 수술 · 금액은 모두 가상 데이터다.

- 서비스: https://cartloop-taupe.vercel.app

## 폴더

| 폴더 | 내용 |
|---|---|
| `cartloop/` | 서비스. 빌드 없는 정적 사이트와 LLM 프록시 함수(`api/llm.js`) |
| `가상 데이터 셋/` | 가상 병원(OO병원) 원본 데이터 |
| `정답지/` | 채점용 정답지 (기록 줄별 정답 코드, 오류 목록, 세트 어긋남) |
| `tools/` | 정답지 생성, 샘플 묶기, 브라우저 없이 전체 흐름 실행, 채점 |

## 로컬 실행

상위 폴더에 `.env` 를 두고 OpenRouter 키를 넣는다 (`Open_Router_key1=...` 여러 줄, 또는 `OPENROUTER_KEYS=키1,키2`).

```
node cartloop/dev-server.mjs          # http://localhost:5173
node tools/run-pipeline.mjs --cache   # 브라우저 없이 전체 흐름 실행
node tools/score.mjs --detail         # 정답지와 비교
```

데이터를 바꾸면 `python tools/build_answer_key.py`, `node tools/make-sample.mjs` 를 다시 돌린다.

## 배포

```
cd cartloop
npx vercel deploy --prod --yes
```

키는 Vercel 환경변수 `OPENROUTER_KEYS` 에 쉼표로 이어 넣는다.
