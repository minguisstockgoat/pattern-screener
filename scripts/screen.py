#!/usr/bin/env python3
"""KRX 패턴 스크리너.

일봉 수집(증분+백필) -> 시총 필터 -> 패턴 감지(쌍바닥/쌍봉/신고가/돌파)
-> 대시보드용 JSON(docs/data) 생성. 외부 패키지 없이 표준 라이브러리만 사용.
"""
import csv
import gzip
import io
import json
import os
import shutil
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HIST_PATH = ROOT / "data" / "history.csv.gz"
OUT_DIR = ROOT / "docs" / "data"

API = {
    "KOSPI": "https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd",
    "KOSDAQ": "https://data-dbg.krx.co.kr/svc/apis/sto/ksq_bydd_trd",
}
MIN_MKTCAP = 3_000e8      # 시총 3천억
MAX_BARS = 300            # 종목당 보관 거래일 수
BACKFILL_CAL_DAYS = 460   # 최초 백필 달력일수 (~310 거래일)
CHART_BARS = 260          # 차트 JSON에 담는 거래일 수

HIST_COLS = ["date", "ticker", "name", "market", "open", "high", "low", "close", "volume", "mktcap"]


# ---------------------------------------------------------------- 수집

def api_key():
    key = os.environ.get("KRX_API_KEY", "").strip()
    if not key:
        sys.exit("KRX_API_KEY 환경변수가 없습니다.")
    return key


def fetch_day(market, yyyymmdd, key):
    req = urllib.request.Request(f"{API[market]}?basDd={yyyymmdd}", headers={"AUTH_KEY": key})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(2 * (attempt + 1))
    rows = []
    for it in data.get("OutBlock_1") or []:
        def num(f):
            v = str(it.get(f, "") or "0").replace(",", "")
            try:
                return float(v)
            except ValueError:
                return 0.0
        rows.append({
            "date": yyyymmdd,
            "ticker": it.get("ISU_CD", ""),
            "name": it.get("ISU_NM", ""),
            "market": market,
            "open": num("TDD_OPNPRC"),
            "high": num("TDD_HGPRC"),
            "low": num("TDD_LWPRC"),
            "close": num("TDD_CLSPRC"),
            "volume": num("ACC_TRDVOL"),
            "mktcap": num("MKTCAP"),
        })
    return rows


def load_history():
    if not HIST_PATH.exists():
        return []
    with gzip.open(HIST_PATH, "rt", encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def save_history(rows):
    HIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(HIST_PATH, "wt", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=HIST_COLS)
        w.writeheader()
        w.writerows(rows)


def update_history():
    key = api_key()
    rows = load_history()
    have_dates = sorted({r["date"] for r in rows})
    today = date.today()
    start = (datetime.strptime(have_dates[-1], "%Y%m%d").date() + timedelta(days=1)
             if have_dates else today - timedelta(days=BACKFILL_CAL_DAYS))
    d, fetched_dates = start, []
    while d <= today:
        if d.weekday() < 5:  # 주말 제외
            ymd = d.strftime("%Y%m%d")
            day_rows = []
            for mkt in API:
                day_rows += fetch_day(mkt, ymd, key)
                time.sleep(0.25)
            if day_rows:  # 휴장일이면 빈 응답
                rows += day_rows
                fetched_dates.append(ymd)
                print(f"  {ymd}: {len(day_rows)} rows")
        d += timedelta(days=1)
    # 오래된 거래일 절사
    all_dates = sorted({r["date"] for r in rows})
    keep = set(all_dates[-MAX_BARS:])
    rows = [r for r in rows if r["date"] in keep]
    if fetched_dates:
        save_history(rows)
    return rows, fetched_dates


# ---------------------------------------------------------------- 패턴 감지

def pivots(vals, k, mode):
    """k칸 양옆보다 낮은(low)/높은(high) 피벗 인덱스."""
    out = []
    for i in range(k, len(vals) - k):
        win = vals[i - k:i + k + 1]
        if mode == "low" and vals[i] == min(win) and win.count(vals[i]) == 1:
            out.append(i)
        if mode == "high" and vals[i] == max(win) and win.count(vals[i]) == 1:
            out.append(i)
    return out


def detect_double_bottom(b):
    """b: dict of lists(date/open/high/low/close/volume). 최적 쌍바닥 1건 or None."""
    n = len(b["close"])
    lo, hi, cl = b["low"], b["high"], b["close"]
    piv = [i for i in pivots(lo, 3, "low") if i >= n - 140]
    best = None
    for a in range(len(piv)):
        for c in range(a + 1, len(piv)):
            p1, p2 = piv[a], piv[c]
            gap = p2 - p1
            if not (10 <= gap <= 80) or p2 < n - 45:
                continue
            l1, l2 = lo[p1], lo[p2]
            diff = abs(l1 - l2) / min(l1, l2)
            if diff > 0.03:
                continue
            # 첫 저점 20일 전부터 현재까지 두 저점보다 낮은 가격이 없어야
            # (두 저점이 해당 구조의 실제 바닥이어야 진짜 쌍바닥)
            if min(lo[max(0, p1 - 20):]) < min(l1, l2) * 0.99:
                continue
            neck = max(hi[p1:p2 + 1])
            depth = neck / ((l1 + l2) / 2) - 1
            if not (0.06 <= depth <= 0.60):
                continue
            # 두 저점 사이에서 넥라인 대비 충분히 반등했는지 (V자 2개 형태)
            last = cl[-1]
            broke_idx = next((i for i in range(max(p2, n - 8), n) if cl[i] > neck), None)
            if broke_idx is not None and last > neck:
                status = "돌파"
            elif last <= neck and last >= min(l1, l2) * 0.99 and p2 >= n - 30:
                status = "형성중"
            else:
                continue
            score = (40 * min(depth / 0.15, 1)
                     + 30 * (1 - diff / 0.04)
                     + 20 * max(0.0, 1 - (n - 1 - p2) / 45)
                     + (10 if status == "돌파" else 0))
            cand = {
                "score": round(score, 1), "status": status,
                "p1_date": b["date"][p1], "p2_date": b["date"][p2],
                "low1": l1, "low2": l2, "neckline": neck,
                "depth_pct": round(depth * 100, 1),
                "detail": f"저점 {l1:,.0f}·{l2:,.0f} / 넥라인 {neck:,.0f} ({status})",
            }
            if best is None or cand["score"] > best["score"]:
                best = cand
    return best


def detect_head_shoulders(b):
    """헤드앤숄더: 어깨-머리-어깨 형성 후 오른어깨 우측에서 넥라인 하향 이탈."""
    n = len(b["close"])
    lo, hi, cl = b["low"], b["high"], b["close"]
    win_start = max(0, n - 160)
    # 머리 = 최근 160거래일의 실제 최고점 봉 (천장 패턴이므로 그 위에 봉우리가 없어야 함)
    hd = max(range(win_start, n), key=lambda i: hi[i])
    h = hi[hd]
    if hd < win_start + 10 or hd > n - 10:
        return None  # 머리가 구간 양끝에 붙어 있으면 좌/우 어깨 성립 불가
    piv = pivots(hi, 3, "high")
    left = [i for i in piv if win_start <= i < hd - 4]
    right = [i for i in piv if hd + 4 < i < n]
    best = None
    for ls in left:
        for rs in right:
            if not (25 <= rs - ls <= 140):
                continue
            s1, s2 = hi[ls], hi[rs]
            if h < max(s1, s2) * 1.03:      # 머리가 어깨보다 3% 이상 높아야
                continue
            if max(hi[rs:]) > s2:           # 오른어깨 이후 더 높은 봉우리가 없어야
                continue
            sym = abs(s1 - s2) / min(s1, s2)
            if sym > 0.08:                   # 양 어깨 높이 비슷해야
                continue
            g1, g2 = hd - ls, rs - hd
            if not (0.4 <= g1 / g2 <= 2.5):  # 좌우 간격 균형
                continue
            t1i = min(range(ls, hd + 1), key=lambda i: lo[i])
            t2i = min(range(hd, rs + 1), key=lambda i: lo[i])
            t1, t2 = lo[t1i], lo[t2i]
            if t1 <= 0 or t2 <= 0 or t2i == t1i:
                continue
            if abs(t2 - t1) / min(t1, t2) > 0.10:  # 넥라인 과도한 기울기 배제
                continue
            if max(hi[ls:t1i + 1]) > s1:    # 왼어깨는 자기~첫 골 구간의 최고점
                continue
            if max(hi[t2i:rs + 1]) > s2:    # 오른어깨는 둘째 골~자기 구간의 최고점
                continue

            def neck(i):  # 두 골을 잇는 기울어진 넥라인
                return t1 + (t2 - t1) * (i - t1i) / (t2i - t1i)

            depth = h / ((t1 + t2) / 2) - 1
            if not (0.05 <= depth <= 0.45):
                continue
            # 오른어깨 이후 넥라인 하향 이탈 + 현재도 넥라인 아래
            brk = next((i for i in range(rs + 1, n) if cl[i] < neck(i)), None)
            if brk is None or brk < n - 20 or cl[-1] >= neck(n - 1):
                continue
            score = (30 * min(depth / 0.20, 1)
                     + 25 * (1 - sym / 0.08)
                     + 25 * max(0.0, 1 - (n - 1 - brk) / 20)
                     + 20 * min((h / max(s1, s2) - 1) / 0.10, 1))
            cand = {
                "score": round(score, 1), "status": "이탈",
                "ls_date": b["date"][ls], "hd_date": b["date"][hd], "rs_date": b["date"][rs],
                "t1_date": b["date"][t1i], "t2_date": b["date"][t2i],
                "t1": t1, "t2": t2, "brk_date": b["date"][brk],
                "neck_last": round(neck(n - 1), 2),
                "depth_pct": round(depth * 100, 1),
                "detail": (f"어깨 {s1:,.0f}·{s2:,.0f} / 머리 {h:,.0f} / "
                           f"넥라인 이탈 {b['date'][brk][4:6]}/{b['date'][brk][6:]}"),
            }
            if best is None or cand["score"] > best["score"]:
                best = cand
    return best


def detect_new_high(b, lookback):
    cl = b["close"]
    if len(cl) < lookback + 1:
        return None
    win = cl[-lookback:]
    if cl[-1] < max(win):
        return None
    prev_high = max(win[:-1])
    margin = cl[-1] / prev_high - 1
    vol_ratio = b["volume"][-1] / (sum(b["volume"][-21:-1]) / 20 + 1e-9)
    score = round(50 * min(margin / 0.05, 1) + 30 * min(vol_ratio / 3, 1) + 20, 1)
    return {
        "score": score, "status": "신고가",
        "margin_pct": round(margin * 100, 2),
        "vol_ratio": round(vol_ratio, 1),
        "detail": f"직전고점 대비 +{margin * 100:.1f}% / 거래량 {vol_ratio:.1f}배",
    }


def detect_box_breakout(b):
    n = len(b["close"])
    if n < 45:
        return None
    hi, lo, cl, vol = b["high"], b["low"], b["close"], b["volume"]
    box_hi = max(hi[-41:-1])
    box_lo = min(lo[-41:-1])
    width = (box_hi - box_lo) / box_lo
    if width > 0.18 or cl[-1] <= box_hi:
        return None
    vol_ratio = vol[-1] / (sum(vol[-21:-1]) / 20 + 1e-9)
    score = round(40 * (1 - width / 0.18) + 40 * min(vol_ratio / 3, 1) + 20, 1)
    return {
        "score": score, "status": "돌파",
        "box_high": box_hi, "box_low": box_lo,
        "width_pct": round(width * 100, 1), "vol_ratio": round(vol_ratio, 1),
        "detail": f"박스 {box_lo:,.0f}~{box_hi:,.0f} (폭 {width * 100:.0f}%) 돌파 / 거래량 {vol_ratio:.1f}배",
    }


# ---------------------------------------------------------------- 조립

def is_common_stock(ticker, name):
    if not ticker.endswith("0"):  # 우선주 등
        return False
    return not any(x in name for x in ("스팩", "SPAC"))


def build():
    rows, fetched = update_history()
    if not rows:
        sys.exit("히스토리가 비어 있습니다.")

    by_ticker = {}
    for r in rows:
        by_ticker.setdefault(r["ticker"], []).append(r)
    latest_date = max(r["date"] for r in rows)

    summary = {"double_bottom": [], "head_shoulders": [], "high_52w": [], "high_60d": [], "box_breakout": []}
    charts = {}

    for ticker, rs in by_ticker.items():
        rs.sort(key=lambda r: r["date"])
        last = rs[-1]
        if last["date"] != latest_date:
            continue  # 거래정지 등
        mktcap = float(last["mktcap"])
        if mktcap < MIN_MKTCAP or not is_common_stock(ticker, last["name"]):
            continue
        if len(rs) < 70:
            continue
        b = {k: [float(r[k]) for r in rs] for k in ("open", "high", "low", "close", "volume")}
        b["date"] = [r["date"] for r in rs]
        if 0.0 in b["close"][-150:] or 0.0 in b["low"][-150:]:
            continue  # 무거래/거래정지 이력 (패턴 탐색 구간 내 0원 봉)

        prev_close = b["close"][-2]
        base = {
            "ticker": ticker, "name": last["name"], "market": last["market"],
            "close": b["close"][-1],
            "chg_pct": round((b["close"][-1] / prev_close - 1) * 100, 2) if prev_close else 0,
            "mktcap_100m": round(mktcap / 1e8),
        }
        found = {}
        db = detect_double_bottom(b)
        if db:
            found["double_bottom"] = db
        hs = detect_head_shoulders(b)
        if hs:
            found["head_shoulders"] = hs
        h52 = detect_new_high(b, 252)
        if h52:
            found["high_52w"] = h52
        elif True:
            h60 = detect_new_high(b, 60)
            if h60:
                found["high_60d"] = h60
        bo = detect_box_breakout(b)
        if bo:
            found["box_breakout"] = bo

        if not found:
            continue
        for pat, info in found.items():
            summary[pat].append({**base, **info})
        charts[ticker] = make_chart_payload(b, base, found)

    for pat in summary:
        summary[pat].sort(key=lambda x: -x["score"])

    write_outputs(latest_date, summary, charts)
    print(f"기준일 {latest_date} / 신규수집 {len(fetched)}일 / "
          + " ".join(f"{k}:{len(v)}" for k, v in summary.items()))
    return bool(fetched)


def make_chart_payload(b, base, found):
    s = max(0, len(b["close"]) - CHART_BARS)
    dates = b["date"][s:]

    def iso(d):
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"

    payload = {
        "name": base["name"], "ticker": base["ticker"], "market": base["market"],
        "candles": [
            {"time": iso(b["date"][i]), "open": b["open"][i], "high": b["high"][i],
             "low": b["low"][i], "close": b["close"][i], "volume": b["volume"][i]}
            for i in range(s, len(b["close"]))
        ],
        "markers": [], "lines": [], "patterns": sorted(found.keys()),
    }
    db = found.get("double_bottom")
    if db:
        payload["markers"] += [
            {"time": iso(db["p1_date"]), "position": "belowBar", "shape": "arrowUp", "text": "저점1"},
            {"time": iso(db["p2_date"]), "position": "belowBar", "shape": "arrowUp", "text": "저점2"},
        ]
        payload["lines"].append({"price": db["neckline"], "title": "쌍바닥 넥라인"})
    hs = found.get("head_shoulders")
    if hs:
        payload["markers"] += [
            {"time": iso(hs["ls_date"]), "position": "aboveBar", "shape": "arrowDown", "text": "왼어깨"},
            {"time": iso(hs["hd_date"]), "position": "aboveBar", "shape": "arrowDown", "text": "머리"},
            {"time": iso(hs["rs_date"]), "position": "aboveBar", "shape": "arrowDown", "text": "오른어깨"},
        ]
        payload["segments"] = payload.get("segments", []) + [{
            "title": "H&S 넥라인",
            "points": [
                {"time": iso(hs["t1_date"]), "value": hs["t1"]},
                {"time": iso(hs["t2_date"]), "value": hs["t2"]},
                {"time": iso(b["date"][-1]), "value": hs["neck_last"]},
            ],
        }]
    bo = found.get("box_breakout")
    if bo:
        payload["lines"].append({"price": bo["box_high"], "title": "박스 상단"})
        payload["lines"].append({"price": bo["box_low"], "title": "박스 하단"})
    payload["markers"].sort(key=lambda m: m["time"])
    return payload


def write_outputs(latest_date, summary, charts):
    charts_dir = OUT_DIR / "charts"
    if charts_dir.exists():
        shutil.rmtree(charts_dir)
    charts_dir.mkdir(parents=True, exist_ok=True)
    for ticker, payload in charts.items():
        (charts_dir / f"{ticker}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    out = {
        "base_date": latest_date,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "min_mktcap_100m": int(MIN_MKTCAP / 1e8),
        "patterns": summary,
    }
    (OUT_DIR / "summary.json").write_text(
        json.dumps(out, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    build()
