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

let DATA = null;
let state = { tab: "double_bottom", sortKey: "score", sortDesc: true, selected: null };
let chart = null, candleSeries = null, volSeries = null, priceLines = [];

const fmt = (n) => Number(n).toLocaleString("ko-KR");

async function init() {
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
    btn.onclick = () => { state.tab = p.key; state.sortKey = "score"; state.sortDesc = true; renderTabs(); renderTable(); };
    nav.appendChild(btn);
  }
}

function rows() {
  const list = [...(DATA.patterns[state.tab] || [])];
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
  drawChart(d, row);
}

function drawChart(d, row) {
  const el = document.getElementById("chart");
  el.innerHTML = "";
  if (chart) { chart.remove(); chart = null; }

  const css = getComputedStyle(document.documentElement);
  const c = (v) => css.getPropertyValue(v).trim();
  chart = LightweightCharts.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: c("--ink2"), fontSize: 11 },
    grid: { vertLines: { color: "#1c2330" }, horzLines: { color: "#1c2330" } },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: c("--border") },
    timeScale: { borderColor: c("--border"), timeVisible: false },
    autoSize: true,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: c("--up"), borderUpColor: c("--up"), wickUpColor: c("--up"),
    downColor: c("--down"), borderDownColor: c("--down"), wickDownColor: c("--down"),
  });
  candleSeries.setData(d.candles);
  volSeries = chart.addHistogramSeries({
    priceScaleId: "vol", priceFormat: { type: "volume" }, color: "#3a4456",
  });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  volSeries.setData(d.candles.map((k) => ({
    time: k.time, value: k.volume,
    color: k.close >= k.open ? "rgba(240,68,82,.45)" : "rgba(49,130,246,.45)",
  })));
  candleSeries.setMarkers((d.markers || []).map((m) => ({
    ...m, color: m.position === "belowBar" ? c("--up") : c("--down"), size: 1,
  })));
  for (const seg of d.segments || []) {
    const s = chart.addLineSeries({
      color: c("--accent"), lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, title: seg.title,
    });
    s.setData(seg.points);
  }
  for (const ln of d.lines || []) {
    candleSeries.createPriceLine({
      price: ln.price, title: ln.title, color: c("--accent"),
      lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
    });
  }
  chart.timeScale().fitContent();

  document.getElementById("chartHead").innerHTML =
    `<h2>${d.name}</h2><span class="sub">${d.market} ${d.ticker} · 종가 ${fmt(row.close)} · ` +
    `${row.chg_pct > 0 ? "+" : ""}${row.chg_pct.toFixed(2)}%</span>`;
  document.getElementById("detail").textContent = row.detail || "";
}

init();
