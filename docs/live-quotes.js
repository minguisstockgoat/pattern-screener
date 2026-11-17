/* KRX quotes only: do not mix NXT volume/OHLC into the KRX daily history. */
(function (root) {
  const MAX_AGE = 90 * 1000;
  const number = value => value == null || value === "" ? NaN : Number(String(value).replaceAll(",", ""));
  const kstDate = (now = Date.now()) => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  function parse(item) {
    const value = key => number(item[key + "Raw"] ?? item[key]);
    const q = {
      ticker: item.itemCode, price: value("closePrice"), change: value("fluctuationsRatio"),
      open: value("openPrice"), high: value("highPrice"), low: value("lowPrice"),
      volume: value("accumulatedTradingVolume"), at: item.localTradedAt,
      market: item.marketStatus, stopped: item.tradeStopType?.code !== "1",
    };
    if (!/^\d{6}$/.test(q.ticker) || !(q.price > 0) || !Number.isFinite(Date.parse(q.at))) return null;
    q.date = kstDate(Date.parse(q.at));
    return q;
  }
  function status(q, failed = false, now = Date.now()) {
    if (!q) return failed ? "조회 실패" : "조회 중";
    if (failed) return "조회 실패 · 이전 시세";
    if (q.stopped) return "거래정지";
    if (q.date !== kstDate(now)) return "이전 거래일";
    const age = now - Date.parse(q.at);
    if (age < -60000) return "시각 확인 필요";
    if (q.market === "CLOSE" || q.market === "CLOSED") return "장 마감";
    if (q.market !== "OPEN") return "장중 아님";
    return age > MAX_AGE ? "시세 지연" : "장중";
  }
  function signal(row, pattern, q, failed = false, now = Date.now()) {
    if (status(q, failed, now) !== "장중") return "—";
    if (pattern === "double_bottom" && row.neckline > 0)
      return q.price > row.neckline ? "넥라인 상회 · 잠정" : "넥라인 이하 · 잠정";
    if (pattern === "box_breakout" && row.box_high > 0)
      return q.price > row.box_high ? "상단 돌파 · 잠정" : q.price < row.box_low ? "하단 이탈 · 잠정" : "박스 내 · 잠정";
    // Sloped necklines and rolling highs need a new daily scan. Compare the
    // fixed reference explicitly instead of claiming a newly detected pattern.
    if (pattern === "head_shoulders" && row.neck_last > 0)
      return q.price < row.neck_last ? "기준 넥라인 하회 · 잠정" : "기준 넥라인 이상 · 잠정";
    if (pattern.startsWith("high_") && row.close > 0)
      return q.price > row.close ? "기준 고점 상회 · 잠정" : q.price === row.close ? "기준 고점 도달 · 잠정" : "기준 고점 미달 · 잠정";
    return "—";
  }
  function candles(history, q, failed = false, now = Date.now()) {
    const result = history.map(c => ({ ...c }));
    if (!["장중", "장 마감"].includes(status(q, failed, now))) return result;
    if (![q.open, q.high, q.low].every(n => n > 0) || !Number.isFinite(q.volume) || q.volume < 0 ||
        q.high < Math.max(q.open, q.price) || q.low > Math.min(q.open, q.price)) return result;
    const last = result.at(-1);
    if (last && q.date < last.time) return result;
    const bar = { time: q.date, open: q.open, high: q.high, low: q.low, close: q.price, volume: q.volume };
    if (last?.time === q.date) result[result.length - 1] = bar;
    else result.push(bar);
    return result;
  }
  function hasHistoryGap(lastDate, quoteDate) {
    const end = Date.parse(quoteDate);
    for (let day = Date.parse(lastDate) + 86400000; day < end; day += 86400000) {
      const weekday = new Date(day).getUTCDay();
      if (weekday !== 0 && weekday !== 6) return true;
    }
    return false;
  }
  const api = { parse, status, signal, candles, hasHistoryGap, kstDate };
  if (typeof module !== "undefined") module.exports = api;
  else root.LiveQuotes = api;
})(globalThis);
