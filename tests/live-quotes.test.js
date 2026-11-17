const { test } = require('node:test');
const assert = require('node:assert/strict');
const live = require('../docs/live-quotes.js');
const now = Date.parse('2026-11-17T11:30:10+09:00');
const raw = { itemCode:'005930', closePrice:'1,100', fluctuationsRatio:'10.00',
  openPrice:'1,000', highPrice:'1,120', lowPrice:'990', accumulatedTradingVolume:'123,456',
  localTradedAt:'2026-11-17T11:30:00+09:00', marketStatus:'OPEN', tradeStopType:{code:'1'},
  overMarketPriceInfo:{overPrice:'9999', accumulatedTradingVolume:'9000000'} };
const q = live.parse(raw);
test('uses KRX OHLC and volume, never NXT or integrated values', () => {
  assert.equal(q.price, 1100); assert.equal(q.volume,123456);
  assert.equal(live.status(q,false,now),'장중');
  assert.equal(live.parse({...raw,closePrice:null}),null);
  assert.equal(live.parse({...raw,localTradedAt:'bad'}),null);
});
test('stale, failed, old-session and halted quotes cannot emit intraday signals', () => {
  const row={neckline:1050};
  assert.equal(live.signal(row,'double_bottom',q,false,now),'넥라인 상회 · 잠정');
  assert.equal(live.status(q,false,now+91000),'시세 지연');
  assert.equal(live.signal(row,'double_bottom',q,false,now+91000),'—');
  assert.equal(live.signal(row,'double_bottom',q,true,now),'—');
  assert.equal(live.signal(row,'double_bottom',{...q,stopped:true},false,now),'—');
  assert.equal(live.signal(row,'double_bottom',{...q,market:'CLOSE'},false,now),'—');
  assert.equal(live.status(q,false,now+86400000),'이전 거래일');
});
test('breakout can reverse without mutating the confirmed row', () => {
  const row={box_high:1050,box_low:950,status:'돌파'};
  assert.equal(live.signal(row,'box_breakout',q,false,now),'상단 돌파 · 잠정');
  assert.equal(live.signal(row,'box_breakout',{...q,price:1000},false,now),'박스 내 · 잠정');
  assert.equal(live.signal(row,'box_breakout',{...q,price:900},false,now),'하단 이탈 · 잠정');
  assert.equal(row.status,'돌파');
});
test('today candle appends once then updates; historical input remains untouched', () => {
  const original=[{time:'2026-11-16',open:990,high:1020,low:980,close:1000,volume:900}];
  const first=live.candles(original,q,false,now);
  assert.equal(first.length,2);assert.equal(original.length,1);
  const next=live.candles(first,{...q,price:1110},false,now);
  assert.equal(next.length,2);assert.equal(next[1].close,1110);assert.equal(first[1].close,1100);
  assert.deepEqual(live.candles(original,q,true,now),original);
  assert.deepEqual(live.candles(original,{...q,high:900},false,now),original);
});
test('KRX day is independent of browser timezone and future quote times are rejected', () => {
  assert.equal(live.kstDate(Date.parse('2026-11-16T23:30:00Z')),'2026-11-17');
  assert.equal(live.status({...q,at:'2026-11-17T12:30:00+09:00'},false,now),'시각 확인 필요');
});
test('missing weekday candles are flagged but weekends alone are not', () => {
  assert.equal(live.hasHistoryGap('2026-11-13','2026-11-16'),false);
  assert.equal(live.hasHistoryGap('2026-11-13','2026-11-17'),true);
  assert.equal(live.hasHistoryGap('2026-11-16','2026-11-18'),true);
  assert.equal(live.hasHistoryGap('2026-11-17','2026-11-17'),false);
});
