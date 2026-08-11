const PATTERNS = [
  { key: "double_bottom", label: "쌍바닥" },
  { key: "head_shoulders", label: "헤드앤숄더" },
  { key: "box_breakout", label: "박스권 돌파" },
  { key: "high_52w", label: "52주 신고가" },
  { key: "high_60d", label: "60일 신고가" },
];
const COLS = [
  { key: "name", label: "종목명", num: false },
  { key: "close", label: "종가", num: true },
  { key: "chg_pct", label: "등락률", num: true },
  { key: "mktcap_100m", label: "시총(억)", num: true },
  { key: "score", label: "점수", num: true },
  { key: "status", label: "상태", num: false },
];
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
let state = { tab: "double_bottom", sortKey: "score", sortDesc: true, selected: null, status: "전체" };
let chart = null;
let lastChart = null; // {d, row} 재렌더용
let ind = loadInd();

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
      renderTabs(); renderTable();
    };
    nav.appendChild(btn);
  }
  renderStatusBar();
}

function renderStatusBar() {
  const bar = document.getElementById("statusbar");
  const list = DATA.patterns[state.tab] || [];
  const statuses = [...new Set(list.map((r) => r.status))];
  if (statuses.length < 2) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = "";
  for (const st of ["전체", ...statuses]) {
    const cnt = st === "전체" ? list.length : list.filter((r) => r.status === st).length;
    const chip = document.createElement("button");
    chip.className = "st-chip" + (state.status === st ? " on" : "");
    chip.innerHTML = `${st}<span class="cnt">${cnt}</span>`;
    chip.onclick = () => { state.status = st; renderStatusBar(); renderTable(); };
    bar.appendChild(chip);
  }
}

function rows() {
  let list = [...(DATA.patterns[state.tab] || [])];
  if (state.status !== "전체") list = list.filter((r) => r.status === state.status);
  const { sortKey, sortDesc } = state;
  const numCol = COLS.find((c) => c.key === sortKey)?.num;
  list.sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    const r = numCol ? x - y : String(x).localeCompare(String(y), "ko");
    return sortDesc ? -r : r;
  });
  return list;
}

function renderTable() {
  const thead = document.querySelector("#tbl thead");
  const tbody = document.querySelector("#tbl tbody");
  thead.innerHTML = "<tr>" + COLS.map((c) =>
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
    const chgCls = r.chg_pct > 0 ? "up" : r.chg_pct < 0 ? "dn" : "";
    const hot = ["돌파", "이탈", "신고가"].includes(r.status);
    tr.innerHTML =
      `<td><span class="nm">${r.name}</span><span class="mkt">${r.market} ${r.ticker}</span></td>` +
      `<td>${fmt(r.close)}</td>` +
      `<td class="${chgCls}">${r.chg_pct > 0 ? "+" : ""}${r.chg_pct.toFixed(2)}%</td>` +
      `<td>${fmt(r.mktcap_100m)}</td>` +
      `<td>${r.score.toFixed(1)}</td>` +
      `<td><span class="badge${hot ? " hot" : ""}">${r.status}</span></td>`;
    tr.title = r.detail || "";
    tr.onclick = () => selectStock(r);
    tbody.appendChild(tr);
  }
}

async function selectStock(row) {
  state.selected = row.ticker;
  renderTable();
  const res = await fetch(`data/charts/${row.ticker}.json?v=${DATA.base_date}`);
  const d = await res.json();
  lastChart = { d, row };
  drawChart(d, row);
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

function drawChart(d, row) {
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

  chart.timeScale().fitContent();

  document.getElementById("chartHead").innerHTML =
    `<h2>${d.name}</h2><span class="sub">${d.market} ${d.ticker} · 종가 ${fmt(row.close)} · ` +
    `${row.chg_pct > 0 ? "+" : ""}${row.chg_pct.toFixed(2)}%</span>`;
  document.getElementById("detail").textContent = row.detail || "";
}

init();
