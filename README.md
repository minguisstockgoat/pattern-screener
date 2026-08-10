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
