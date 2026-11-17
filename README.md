# 패턴 스크리너

KOSPI·KOSDAQ 시가총액 3,000억 이상 종목을 대상으로 차트 패턴을 매일 스크리닝해
GitHub Pages 대시보드로 보여준다.

- 패턴: 쌍바닥, 쌍봉, 박스권 돌파, 52주/60일 신고가
- 데이터: KRX Data Marketplace OPEN API (정규장 기준, NXT 체결분 미포함)
- 갱신: GitHub Actions가 평일 18:45 KST + 익일 08:15 KST 실행 (새 데이터 없으면 커밋 생략)

## 구조

- `scripts/screen.py` — 수집(증분+백필) → 패턴 감지 → `docs/data/*.json` 생성 (표준 라이브러리만 사용)
- `data/history.csv.gz` — 일봉 히스토리(최근 300거래일)
- `docs/` — GitHub Pages 정적 대시보드 (main 브랜치 `/docs` 서빙)

## 로컬 실행

```
set KRX_API_KEY=...   # 또는 환경변수 사전 등록
py -3 scripts/screen.py
```

`docs/index.html`을 브라우저로 열면 확인 가능 (fetch 때문에 간단히는 `py -3 -m http.server -d docs`).

## 배포 설정

1. 저장소 Secrets에 `KRX_API_KEY` 등록
2. Settings → Pages → Source: `main` 브랜치 `/docs` 폴더

## 장중 시세

- 현재 탭 후보와 선택 종목의 KRX 현재가·등락률·누적 거래량을 네이버 금융에서 15초 주기로 조회한다. 기존 전용 Cloudflare 중계를 사용하며 브라우저에 비밀키를 넣지 않는다.
- 한 요청에 최대 20종목, 동시 요청 2개로 제한한다. 숨겨진 탭은 조회를 멈추고 다시 보이면 갱신한다.
- 체결 시각이 90초 이상 지난 장중 가격, 이전 거래일 시세, 조회 실패, 거래정지는 별도로 표시한다. 실패 시 마지막 수신 가격을 남기되 잠정 신호는 숨긴다.
- 후보·점수·확정 상태는 기존 종가 결과를 보존한다. 잠정 비교는 저장된 넥라인·박스와 비교하며, 헤드앤숄더는 기준일 넥라인, 신고가 탭은 기준일 고점(종가)과 비교한다. 전체 종목 재검색이나 새로운 신고가 판정은 하지 않는다.
- 선택 차트의 오늘 KRX 일봉과 보조지표를 갱신한다. NXT OHLC·거래량은 섞지 않는다. 중간 일봉 공백 가능성을 표시하며, 자동 갱신 시 차트 확대 범위를 유지한다.
- 검증: `node --test tests/live-quotes.test.js`.
