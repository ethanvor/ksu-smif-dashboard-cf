// Shared Yahoo Finance helpers (no API key needed).
// Browsers can't call Yahoo directly (CORS), so these run server-side on Cloudflare.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let session = null; // { cookie, crumb, at }

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...extra,
    },
  });
}

export function cleanSymbol(s) {
  return String(s || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-^=]/g, '')
    .slice(0, 15);
}

// Cookie + crumb are required for quoteSummary (fundamentals). Cached per warm instance.
async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < 30 * 60 * 1000) return session;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA }, redirect: 'manual' });
  const raw = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : typeof r1.headers.getAll === 'function' ? r1.headers.getAll('set-cookie') : [r1.headers.get('set-cookie') || ''];
  const cookie = raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'user-agent': UA, cookie },
  });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes('<')) throw new Error('Could not obtain Yahoo crumb');
  session = { cookie, crumb, at: Date.now() };
  return session;
}

// Daily price history + latest quote from the chart endpoint (no crumb needed).
export async function chart(symbol, range = '1y', interval = '1d') {
  // "all" = weekly bars since mid-2009 (covers the fund's whole Schwab record) without pulling decades of data
  const span = range === 'all' ? `period1=${Math.floor(Date.UTC(2009, 5, 1) / 1000)}&period2=${Math.floor(Date.now() / 1000)}` : `range=${range}`;
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?${span}&interval=${interval}&includePrePost=false&events=div%2Csplit`;
  let r = await fetch('https://query1.finance.yahoo.com' + path, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok && r.status !== 404) r = await fetch('https://query2.finance.yahoo.com' + path, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`chart ${symbol}: HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(j?.chart?.error?.description || `No data for ${symbol}`);
  const m = res.meta || {};
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose || q.close || [];
  const t = [], c = [], raw = [];
  (res.timestamp || []).forEach((ts, i) => {
    const v = adj[i] ?? q.close?.[i];
    if (v != null && isFinite(v)) {
      t.push(new Date(ts * 1000).toISOString().slice(0, 10));
      c.push(+v.toFixed(4));
      raw.push(q.close?.[i] ?? v);
    }
  });
  // Yesterday's close for the day-change: if the last bar is today's session, use the bar before it.
  const mDate = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
  const n = raw.length;
  const dayPrev = n >= 2 ? (t[n - 1] === mDate ? raw[n - 2] : raw[n - 1]) : null;
  return {
    symbol: m.symbol || symbol,
    name: m.longName || m.shortName || symbol,
    currency: m.currency,
    exchange: m.fullExchangeName || m.exchangeName,
    type: m.instrumentType,
    price: m.regularMarketPrice,
    dayPrevClose: dayPrev,
    high52: m.fiftyTwoWeekHigh,
    low52: m.fiftyTwoWeekLow,
    marketTime: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    dates: t,
    closes: c, // adjusted for splits AND dividends (for return/risk math)
    rawCloses: raw.map((v) => +(+v).toFixed(4)), // split-adjusted only (for valuing actual share counts)
    splits: Object.values(res.events?.splits || {}).map((x) => [new Date(x.date * 1000).toISOString().slice(0, 10), x.numerator / x.denominator]).sort(),
  };
}

const MODULES = 'price,assetProfile,summaryDetail,defaultKeyStatistics,financialData';

export async function summary(symbol) {
  const go = async (s) =>
    fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES}&crumb=${encodeURIComponent(s.crumb)}`,
      { headers: { 'user-agent': UA, cookie: s.cookie } }
    );
  let s = await getSession();
  let r = await go(s);
  if (r.status === 401 || r.status === 403) {
    s = await getSession(true);
    r = await go(s);
  }
  if (!r.ok) throw new Error(`quoteSummary ${symbol}: HTTP ${r.status}`);
  const j = await r.json();
  const d = j?.quoteSummary?.result?.[0];
  if (!d) throw new Error('No fundamentals');
  const v = (o) => (o && typeof o === 'object' && 'raw' in o ? o.raw : o ?? null);
  const p = d.price || {}, a = d.assetProfile || {}, sd = d.summaryDetail || {}, ks = d.defaultKeyStatistics || {}, fd = d.financialData || {};
  return {
    symbol,
    name: p.longName || p.shortName || symbol,
    quoteType: p.quoteType,
    sector: a.sector || null,
    industry: a.industry || null,
    country: a.country || null,
    website: a.website || null,
    summary: a.longBusinessSummary ? a.longBusinessSummary.slice(0, 900) : null,
    employees: a.fullTimeEmployees ?? null,
    marketCap: v(p.marketCap) ?? v(sd.marketCap),
    trailingPE: v(sd.trailingPE),
    forwardPE: v(sd.forwardPE) ?? v(ks.forwardPE),
    pegRatio: v(ks.pegRatio),
    priceToBook: v(ks.priceToBook),
    evToEbitda: v(ks.enterpriseToEbitda),
    dividendYield: v(sd.dividendYield) ?? v(sd.yield),
    payoutRatio: v(sd.payoutRatio),
    beta: v(sd.beta) ?? v(ks.beta),
    profitMargin: v(fd.profitMargins) ?? v(ks.profitMargins),
    operatingMargin: v(fd.operatingMargins),
    roe: v(fd.returnOnEquity),
    revenueGrowth: v(fd.revenueGrowth),
    earningsGrowth: v(fd.earningsGrowth),
    debtToEquity: v(fd.debtToEquity),
    currentRatio: v(fd.currentRatio),
    freeCashflow: v(fd.freeCashflow),
    targetMeanPrice: v(fd.targetMeanPrice),
    recommendation: fd.recommendationKey || null,
    analystCount: v(fd.numberOfAnalystOpinions),
    fiftyDayAvg: v(sd.fiftyDayAverage),
    twoHundredDayAvg: v(sd.twoHundredDayAverage),
    avgVolume: v(sd.averageVolume),
  };
}

export async function search(q) {
  const r = await fetch(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`,
    { headers: { 'user-agent': UA } }
  );
  if (!r.ok) throw new Error(`search: HTTP ${r.status}`);
  const j = await r.json();
  return (j.quotes || [])
    .filter((x) => x.symbol && ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(x.quoteType))
    .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname, type: x.quoteType, exchange: x.exchDisp }));
}

// Run async tasks with a concurrency cap.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try {
        out[k] = await fn(items[k]);
      } catch (e) {
        out[k] = { symbol: items[k], error: String(e.message || e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
