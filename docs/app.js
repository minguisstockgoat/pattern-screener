const PATTERNS = [
  { key: "double_bottom", label: "쌍바닥" },
  { key: "head_shoulders", label: "헤드앤숄더" },
  { key: "box_breakout", label: "박스권 돌파" },
  { key: "high_52w", label: "52주 신고가" },
  { key: "high_60d", label: "60일 신고가" },
];
const BASE_COLS = [
  { key: "name", label: "종목명", num: false },
  { key: "live_price", label: "현재가", num: true },
  { key: "live_change", label: "등락률", num: true },
  { key: "live_volume", label: "거래량", num: true },
  { key: "live_signal", label: "장중 비교(잠정)", num: false },
  { key: "close", label: "기준 종가", num: true },
  { key: "mktcap_100m", label: "시총(기준일·억)", num: true },
  { key: "score", label: "점수(종가)", num: true },
];
/* 쌍바닥은 "돌파 후 얼마나 갔는지"가 진입 가능 여부를 가른다 — 넥라인 대비 초과폭과
   돌파 후 경과일을 표에 직접 세운다. */
const DB_COLS = [
  { key: "ext_pct", label: "넥라인대비(종가)", num: true,
    render: (r) => (r.status === "돌파" ? `${r.ext_pct > 0 ? "+" : ""}${r.ext_pct.toFixed(1)}%` : "–") },
  { key: "days_since_break", label: "돌파후", num: true,
    render: (r) => (r.status === "돌파" ? `${r.days_since_break}일` : "–") },
];
const STATUS_COL = { key: "status", label: "확정 상태", num: false };
const FRESH_CLS = { 신선: "fresh", 진행: "mid", 소진: "spent" };
function cols() {
  return state.tab === "double_bottom"
    ? [...BASE_COLS, ...DB_COLS, STATUS_COL]
    : [...BASE_COLS, STATUS_COL];
}
const IND_DEFS = [
  { key: "ma5", label: "MA5", color: "#e8c464" },
  { key: "ma20", label: "MA20", color: "#f2994a" },
  { key: "ma60", label: "MA60", color: "#2fbf71" },
  { key: "ma120", label: "MA120", color: "#bb6bd9" },
  { key: "bb", label: "볼린저(20,2σ)", color: "#8899aa" },
  { key: "env", label: "Envelope(20,±6%)", color: "#d96ba8" },
  { key: "rsi", label: "RSI(14)", color: "#4f8ff7" },
  { key: "macd", label: "MACD(12,26,9)", color: "#f2994a" },
];
const IND_DEFAULT = { ma5: false, ma20: true, ma60: true, ma120: false, bb: false, env: false, rsi: false, macd: false };

let DATA = null;
let state = { tab: "double_bottom", sortKey: "score", sortDesc: true, selected: null,
  status: "전체", hideSpent: true };
let chart = null;
let lastChart = null; // {d, row} 재렌더용
let ind = loadInd();

const quotes = new Map();
const quoteFailures = new Set();
const chartCache = new Map();
let quoteTimer = null, quotesBusy = false, quoteAgain = false;
let selectionVersion = 0;
const QUOTE_PROXY = "https://hynix-proxy.eogks879.workers.dev/?url=";
const QUOTE_INTERVAL = 15000;
const escapeHtml = text => String(text ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = (n) => Number(n).toLocaleString("ko-KR");

function loadInd() {
  try {
    return { ...IND_DEFAULT, ...JSON.parse(localStorage.getItem("indicators") || "{}") };
  } catch {
    return { ...IND_DEFAULT };
  }
}
function saveInd() {
  localStorage.setItem("indicators", JSON.stringify(ind));
}

async function init() {
  renderIndBar();
  const res = await fetch(`data/summary.json?v=${Date.now()}`);
  DATA = await res.json();
  document.getElementById("meta").textContent =
    `기준일 ${DATA.base_date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")} · 갱신 ${DATA.generated_at}`;
  renderTabs();
  renderTable();
  refreshQuotes();
  document.addEventListener("visibilitychange", () => {
    clearTimeout(quoteTimer);
    if (!document.hidden) refreshQuotes();
  });
}

function quoteView(row) {
  const q = quotes.get(row.ticker), failed = quoteFailures.has(row.ticker);
  return { ...row, live_price: q?.price ?? null, live_change: q?.change ?? null,
    live_volume: q?.volume ?? null, live_signal: LiveQuotes.signal(row, state.tab, q, failed),
    quote_status: LiveQuotes.status(q, failed), quote: q };
}

function requestQuotes() {
  clearTimeout(quoteTimer);
  if (quotesBusy) quoteAgain = true;
  else refreshQuotes();
}

async function refreshQuotes() {
  if (document.hidden || !DATA) return;
  if (quotesBusy) { quoteAgain = true; return; }
  clearTimeout(quoteTimer);
  quotesBusy = true;
  const tickers = [...new Set([...(DATA.patterns[state.tab] || []).map(r => r.ticker), state.selected].filter(Boolean))];
  const batches = [];
  for (let i = 0; i < tickers.length; i += 20) batches.push(tickers.slice(i, i + 20));
  try {
    await Promise.all(Array.from({length: Math.min(2, batches.length)}, async () => {
      while (batches.length) {
        const batch = batches.shift();
        try {
          const target = "https://polling.finance.naver.com/api/realtime/domestic/stock/" + batch.join(",");
          const res = await fetch(QUOTE_PROXY + encodeURIComponent(target), { cache: "no-store", signal: AbortSignal.timeout(9000) });
          if (!res.ok) throw new Error(`시세 응답 ${res.status}`);
          const body = await res.json();
          if (!Array.isArray(body.datas)) throw new Error("시세 데이터 없음");
          const received = new Set();
          for (const item of body.datas) {
            const q = LiveQuotes.parse(item);
            if (!q || !batch.includes(q.ticker)) continue;
            const previous = quotes.get(q.ticker);
            if (previous && Date.parse(q.at) < Date.parse(previous.at)) continue;
            quotes.set(q.ticker, q); quoteFailures.delete(q.ticker); received.add(q.ticker);
          }
          for (const ticker of batch) if (!received.has(ticker)) quoteFailures.add(ticker);
        } catch (_) { batch.forEach(ticker => quoteFailures.add(ticker)); }
      }
    }));
    renderTable();
    if (lastChart) drawChart(lastChart.d, lastChart.row, true);
    const current = tickers.map(t => LiveQuotes.status(quotes.get(t), quoteFailures.has(t)));
    const live = current.filter(s => s === "장중").length;
    const closed = current.filter(s => s === "장 마감").length;
    const unavailable = current.length - live - closed;
    document.getElementById("liveMeta").textContent =
      `KRX 시세 · 장중 ${live}종 · 장 마감 ${closed}종` + (unavailable ? ` · 지연/이전/미수신 ${unavailable}종` : "") +
      " · 현재 탭 15초 주기 조회 · 개별 체결 시각은 현재가 아래 표시";
  } finally {
    quotesBusy = false;
    const retrySoon = quoteAgain; quoteAgain = false;
    if (!document.hidden) quoteTimer = setTimeout(refreshQuotes, retrySoon ? 0 : QUOTE_INTERVAL);
  }
}

function renderTabs() {
  const nav = document.getElementById("tabs");
  nav.innerHTML = "";
  for (const p of PATTERNS) {
    const btn = document.createElement("button");
    btn.className = "tab" + (state.tab === p.key ? " active" : "");
    btn.innerHTML = `${p.label}<span class="cnt">${(DATA.patterns[p.key] || []).length}</span>`;
    btn.onclick = () => {
      state.tab = p.key; state.sortKey = "score"; state.sortDesc = true; state.status = "전체";
      selectionVersion++;
      state.selected = null;
      lastChart = null;
      if (chart) { chart.remove(); chart = null; }
      document.getElementById("chartHead").textContent = "차트 · 종목을 선택하세요";
      document.getElementById("chart").innerHTML = '<div class="placeholder">종목을 선택하면 캔들차트가 표시됩니다</div>';
      document.getElementById("detail").textContent = "";
      renderTabs(); renderTable(); requestQuotes();
    };
    nav.appendChild(btn);
  }
  renderStatusBar();
}

function renderStatusBar() {
  const bar = document.getElementById("statusbar");
  const list = DATA.patterns[state.tab] || [];
  const statuses = [...new Set(list.map((r) => r.status))];
  const spent = list.filter((r) => r.freshness === "소진").length;
  if (statuses.length < 2 && !spent) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = "";
  if (spent) {
    const chip = document.createElement("button");
    chip.className = "st-chip" + (state.hideSpent ? " on" : "");
    chip.title = "넥라인 초과폭이 패턴 깊이를 넘었거나(목표가 도달), 패턴 이전 고점을 회복했거나, "
      + "신고가이거나, 돌파 후 20일이 지난 종목 — 더는 바닥 반등 자리로 보기 어렵습니다.";
    chip.innerHTML = `과열 제외<span class="cnt">${spent}</span>`;
    chip.onclick = () => { state.hideSpent = !state.hideSpent; renderStatusBar(); renderTable(); };
    bar.appendChild(chip);
  }
  for (const st of ["전체", ...statuses]) {
    const pool = state.hideSpent ? list.filter((r) => r.freshness !== "소진") : list;
    const cnt = st === "전체" ? pool.length : pool.filter((r) => r.status === st).length;
    const chip = document.createElement("button");
    chip.className = "st-chip" + (state.status === st ? " on" : "");
    chip.innerHTML = `${st}<span class="cnt">${cnt}</span>`;
    chip.onclick = () => { state.status = st; renderStatusBar(); renderTable(); };
    bar.appendChild(chip);
  }
}

function rows() {
  let list = [...(DATA.patterns[state.tab] || [])];
  if (state.hideSpent) list = list.filter((r) => r.freshness !== "소진");
  if (state.status !== "전체") list = list.filter((r) => r.status === state.status);
  list = list.map(quoteView);
  const { sortKey, sortDesc } = state;
  const numCol = cols().find((c) => c.key === sortKey)?.num;
  list.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    if (numCol && (x == null || !Number.isFinite(x))) return y == null || !Number.isFinite(y) ? 0 : 1;
    if (numCol && (y == null || !Number.isFinite(y))) return -1;
    const r = numCol ? x - y : String(x).localeCompare(String(y), "ko");
    return sortDesc ? -r : r;
  });
  return list;
}

function renderTable() {
  const thead = document.querySelector("#tbl thead");
  const tbody = document.querySelector("#tbl tbody");
  const COL = cols();
  thead.innerHTML = "<tr>" + COL.map((c) =>
    `<th data-k="${c.key}" class="${state.sortKey === c.key ? "sorted" : ""}">${c.label}${
      state.sortKey === c.key ? (state.sortDesc ? " ▾" : " ▴") : ""}</th>`).join("") + "</tr>";
  thead.querySelectorAll("th").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      if (state.sortKey === k) state.sortDesc = !state.sortDesc;
      else { state.sortKey = k; state.sortDesc = true; }
      renderTable();
    };
  });

  tbody.innerHTML = "";
  for (const r of rows()) {
    const tr = document.createElement("tr");
    if (state.selected === r.ticker) tr.className = "selected";
    tr.innerHTML = COL.map(c => {
      const value = r[c.key];
      if (c.key === "name") return `<td><span class="nm">${escapeHtml(r.name)}</span><span class="mkt">${r.market} ${r.ticker}</span></td>`;
      if (c.key === "live_price") {
        const stamp = r.quote ? `${r.quote.date.slice(5)} ${r.quote.at.slice(11, 19)}` : "";
        return `<td class="quote-cell">${value == null ? "—" : fmt(value)}<small class="${r.quote_status === "장중" ? "live" : "muted"}">${r.quote_status} ${stamp}</small></td>`;
      }
      if (c.key === "live_change") return `<td class="${value > 0 ? "up" : value < 0 ? "dn" : ""}">${Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "—"}</td>`;
      if (c.key === "live_volume") return `<td>${Number.isFinite(value) ? fmt(value) : "—"}</td>`;
      if (c.key === "live_signal") return `<td class="live-signal">${value}</td>`;
      if (c.key === "status") {
        const hot = ["돌파", "이탈", "신고가"].includes(r.status);
        const fcls = FRESH_CLS[r.freshness];
        return `<td><span class="badge${hot ? " hot" : ""}">${r.status}</span>` +
          (fcls ? `<span class="badge fr-${fcls}">${r.freshness}</span>` : "") + "</td>";
      }
      if (c.render) return `<td>${c.render(r)}</td>`;
      return `<td>${c.key === "score" ? value.toFixed(1) : fmt(value)}</td>`;
    }).join("");
    tr.title = r.detail || "";
    tr.onclick = () => selectStock(r);
    tbody.appendChild(tr);
  }
}

async function selectStock(row) {
  const version = ++selectionVersion;
  state.selected = row.ticker;
  lastChart = null;
  if (chart) { chart.remove(); chart = null; }
  document.getElementById("chartHead").textContent = `${row.name} · 차트 불러오는 중…`;
  document.getElementById("detail").textContent = "";
  renderTable();
  requestQuotes();
  try {
    let d = chartCache.get(row.ticker);
    if (!d) {
      const res = await fetch(`data/charts/${row.ticker}.json?v=${DATA.base_date}`);
      if (!res.ok) throw new Error("chart unavailable");
      d = await res.json(); chartCache.set(row.ticker, d);
    }
    if (version !== selectionVersion) return;
    lastChart = { d, row };
    drawChart(d, row);
  } catch (_) {
    if (version === selectionVersion) document.getElementById("chartHead").textContent = `${row.name} · 차트 조회 실패, 다시 선택해 주세요`;
  }
}

// ---------------------------------------------------------------- 보조지표 계산

function smaSeries(candles, p) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= p) sum -= candles[i - p].close;
    if (i >= p - 1) out.push({ time: candles[i].time, value: sum / p });
  }
  return out;
}

function emaArr(vals, p) {
  const k = 2 / (p + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    prev = prev === null ? vals[i] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function bollingerSeries(candles, p = 20, mult = 2) {
  const upper = [], mid = [], lower = [];
  for (let i = p - 1; i < candles.length; i++) {
    const win = candles.slice(i - p + 1, i + 1).map((c) => c.close);
    const m = win.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / p);
    const t = candles[i].time;
    upper.push({ time: t, value: m + mult * sd });
    mid.push({ time: t, value: m });
    lower.push({ time: t, value: m - mult * sd });
  }
  return { upper, mid, lower };
}

function rsiSeries(candles, p = 14) {
  const out = [];
  let avgG = 0, avgL = 0;
  for (let i = 1; i < candles.length; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= p) {
      avgG += g / p; avgL += l / p;
      if (i === p) out.push({ time: candles[i].time, value: 100 - 100 / (1 + avgG / (avgL || 1e-9)) });
    } else {
      avgG = (avgG * (p - 1) + g) / p;
      avgL = (avgL * (p - 1) + l) / p;
      out.push({ time: candles[i].time, value: 100 - 100 / (1 + avgG / (avgL || 1e-9)) });
    }
  }
  return out;
}

function macdSeries(candles, fast = 12, slow = 26, sig = 9) {
  const closes = candles.map((c) => c.close);
  const ef = emaArr(closes, fast), es = emaArr(closes, slow);
  const macd = ef.map((v, i) => v - es[i]);
  const signal = emaArr(macd, sig);
  const start = slow - 1;
  const line = [], sigLine = [], hist = [];
  for (let i = start; i < candles.length; i++) {
    const t = candles[i].time;
    const h = macd[i] - signal[i];
    line.push({ time: t, value: macd[i] });
    sigLine.push({ time: t, value: signal[i] });
    hist.push({ time: t, value: h, color: h >= 0 ? "rgba(240,68,82,.55)" : "rgba(49,130,246,.55)" });
  }
  return { line, sigLine, hist };
}

// ---------------------------------------------------------------- 렌더

function renderIndBar() {
  const bar = document.getElementById("indbar");
  bar.innerHTML = "";
  for (const def of IND_DEFS) {
    const chip = document.createElement("button");
    chip.className = "ind-chip" + (ind[def.key] ? " on" : "");
    chip.innerHTML = `<span class="dot" style="background:${def.color}"></span>${def.label}`;
    chip.onclick = () => {
      ind[def.key] = !ind[def.key];
      saveInd();
      renderIndBar();
      if (lastChart) drawChart(lastChart.d, lastChart.row);
    };
    bar.appendChild(chip);
  }
}

function drawChart(d, row, preserveView = false) {
  const visibleRange = preserveView && chart ? chart.timeScale().getVisibleLogicalRange() : null;
  const original = d;
  const q = quotes.get(row.ticker), failed = quoteFailures.has(row.ticker);
  d = { ...d, candles: LiveQuotes.candles(d.candles, q, failed) };
  const el = document.getElementById("chart");
  el.innerHTML = "";
  if (chart) { chart.remove(); chart = null; }

  const LWC = LightweightCharts;
  const css = getComputedStyle(document.documentElement);
  const c = (v) => css.getPropertyValue(v).trim();
  const subPanes = (ind.rsi ? 1 : 0) + (ind.macd ? 1 : 0);
  el.style.height = `${460 + subPanes * 110}px`;

  chart = LWC.createChart(el, {
    layout: {
      background: { color: "transparent" }, textColor: c("--ink2"), fontSize: 11,
      panes: { separatorColor: c("--border"), separatorHoverColor: c("--accent") },
    },
    grid: { vertLines: { color: "#1c2330" }, horzLines: { color: "#1c2330" } },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    rightPriceScale: { borderColor: c("--border") },
    timeScale: { borderColor: c("--border"), timeVisible: false },
    autoSize: true,
  });

  const candleSeries = chart.addSeries(LWC.CandlestickSeries, {
    upColor: c("--up"), borderUpColor: c("--up"), wickUpColor: c("--up"),
    downColor: c("--down"), borderDownColor: c("--down"), wickDownColor: c("--down"),
  });
  candleSeries.setData(d.candles);

  const volSeries = chart.addSeries(LWC.HistogramSeries, {
    priceScaleId: "vol", priceFormat: { type: "volume" },
    priceLineVisible: false, lastValueVisible: false,
  });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  volSeries.setData(d.candles.map((k) => ({
    time: k.time, value: k.volume,
    color: k.close >= k.open ? "rgba(240,68,82,.45)" : "rgba(49,130,246,.45)",
  })));

  const overlayLine = (data, color, width = 1, style = LWC.LineStyle.Solid) => {
    const s = chart.addSeries(LWC.LineSeries, {
      color, lineWidth: width, lineStyle: style,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    s.setData(data);
    return s;
  };

  for (const p of [5, 20, 60, 120]) {
    if (ind[`ma${p}`]) overlayLine(smaSeries(d.candles, p), IND_DEFS.find((x) => x.key === `ma${p}`).color);
  }
  if (ind.bb) {
    const bb = bollingerSeries(d.candles);
    overlayLine(bb.upper, "#8899aa");
    overlayLine(bb.mid, "#8899aa", 1, LWC.LineStyle.Dotted);
    overlayLine(bb.lower, "#8899aa");
  }
  if (ind.env) {
    const mid = smaSeries(d.candles, 20);
    const pct = 0.06;
    overlayLine(mid.map((p) => ({ time: p.time, value: p.value * (1 + pct) })), "#d96ba8");
    overlayLine(mid, "#d96ba8", 1, LWC.LineStyle.Dotted);
    overlayLine(mid.map((p) => ({ time: p.time, value: p.value * (1 - pct) })), "#d96ba8");
  }

  // 패턴 마커·넥라인
  if (d.markers && d.markers.length) {
    LWC.createSeriesMarkers(candleSeries, d.markers.map((m) => ({
      ...m, color: m.position === "belowBar" ? c("--up") : c("--down"), size: 1,
    })));
  }
  for (const seg of d.segments || []) {
    const s = chart.addSeries(LWC.LineSeries, {
      color: c("--accent"), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      title: seg.title,
    });
    s.setData(seg.points);
  }
  for (const ln of d.lines || []) {
    candleSeries.createPriceLine({
      price: ln.price, title: ln.title, color: c("--accent"),
      lineWidth: 1, lineStyle: LWC.LineStyle.Dashed,
    });
  }

  // 하단 패널: RSI / MACD
  let paneIdx = 1;
  if (ind.rsi) {
    const rsiS = chart.addSeries(LWC.LineSeries, {
      color: "#4f8ff7", lineWidth: 1,
      priceLineVisible: false, lastValueVisible: true, title: "RSI",
    }, paneIdx);
    rsiS.setData(rsiSeries(d.candles));
    for (const lvl of [30, 70]) {
      rsiS.createPriceLine({ price: lvl, color: "#556070", lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, title: String(lvl) });
    }
    paneIdx++;
  }
  if (ind.macd) {
    const m = macdSeries(d.candles);
    const histS = chart.addSeries(LWC.HistogramSeries, {
      priceLineVisible: false, lastValueVisible: false,
    }, paneIdx);
    histS.setData(m.hist);
    const macdS = chart.addSeries(LWC.LineSeries, {
      color: "#f2994a", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "MACD",
    }, paneIdx);
    macdS.setData(m.line);
    const sigS = chart.addSeries(LWC.LineSeries, {
      color: "#4f8ff7", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, title: "Signal",
    }, paneIdx);
    sigS.setData(m.sigLine);
    paneIdx++;
  }
  const panes = chart.panes();
  for (let i = 1; i < panes.length; i++) panes[i].setHeight(110);

  if (visibleRange) chart.timeScale().setVisibleLogicalRange(visibleRange);
  else chart.timeScale().fitContent();

  const quoteStatus = LiveQuotes.status(q, failed);
  const extra = q ? ` · 현재가 ${fmt(q.price)} (${quoteStatus} · ${q.date} ${q.at.slice(11, 19)} KST)` : ` · ${quoteStatus}`;
  document.getElementById("chartHead").innerHTML =
    `<h2>${escapeHtml(d.name)}</h2><span class="sub">${d.market} ${d.ticker} · 기준 종가 ${fmt(row.close)}${extra}</span>`;
  const gap = q && LiveQuotes.hasHistoryGap(original.candles.at(-1)?.time, q.date);
  const hasQuoteBar = q && d.candles.at(-1)?.time === q.date && ["장중", "장 마감"].includes(quoteStatus);
  document.getElementById("detail").textContent = `종가 기준: ${row.detail || ""}` +
    (hasQuoteBar ? " · 마지막 봉과 보조지표에 오늘 KRX 시세 반영(미확정)" : " · 차트는 수집된 종가 기준") +
    (hasQuoteBar && gap ? " · 중간 평일의 일봉이 없습니다(휴장일일 수 있음). 차트·보조지표 해석에 유의하세요." : "");
}

init().catch(() => {
  document.getElementById("meta").textContent = "패턴 데이터를 불러오지 못했습니다. 새로고침해 주세요.";
});
