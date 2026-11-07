// GET /api/prices?symbols=CELG,UTX     — second price source for the Performance tab.
// Used only for tickers whose Yahoo history is missing or doesn't match the fund's own Schwab trade prices
// (delisted stocks, or a ticker that now belongs to a different company).
// Source: Tiingo end-of-day prices (free account; keeps many delisted US stocks). Needs a Secret TIINGO_KEY.
// Results are saved in KV forever (old prices don't change), so each ticker is fetched from Tiingo once.
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const clean = (s) => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 12);
// Monday of the week, so weekly bars line up with Yahoo's weekly bars
const monday = (iso) => { const d = new Date(iso.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

async function tiingo(sym, key) {
  const t = sym.replace(/\./g, '-').toLowerCase();
  const url = `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(t)}/prices?startDate=2009-06-01&resampleFreq=weekly&format=json`;
  const r = await fetch(url, { headers: { authorization: `Token ${key}`, 'content-type': 'application/json' } });
  if (r.status === 404) return { symbol: sym, error: 'Not on Tiingo' };
  if (!r.ok) throw new Error(`Tiingo HTTP ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) return { symbol: sym, error: 'No data on Tiingo' };
  const dates = [], closes = [], raw = [];
  for (const x of rows) {
    if (!(x.adjClose > 0) || !(x.close > 0)) continue;
    const d = monday(x.date);
    if (dates[dates.length - 1] === d) { closes[closes.length - 1] = +x.adjClose.toFixed(4); raw[raw.length - 1] = +x.close.toFixed(4); continue; }
    dates.push(d); closes.push(+x.adjClose.toFixed(4)); raw.push(+x.close.toFixed(4));
  }
  // close = the price as it traded that day (no split adjustment), which matches the share counts in the Schwab history
  return { symbol: sym, source: 'Tiingo', dates, closes, rawCloses: raw, splits: [], fetchedAt: new Date().toISOString() };
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const syms = [...new Set((u.searchParams.get('symbols') || '').split(',').map(clean).filter(Boolean))].slice(0, 10);
  if (!syms.length) return json({ error: 'Pass ?symbols=CELG,UTX' }, 400);
  const out = [];
  for (const s of syms) {
    try {
      const hit = env.SMIF_KV ? await env.SMIF_KV.get(`px2/${s}`, 'json') : null;
      if (hit) { out.push(hit); continue; }
      if (!env.TIINGO_KEY) { out.push({ symbol: s, error: 'No second source set up (add a TIINGO_KEY secret)' }); continue; }
      const d = await tiingo(s, env.TIINGO_KEY);
      if (!d.error && env.SMIF_KV) await env.SMIF_KV.put(`px2/${s}`, JSON.stringify(d));
      out.push(d);
    } catch (e) { out.push({ symbol: s, error: String(e.message || e) }); }
  }
  return json({ data: out, secondSource: !!env.TIINGO_KEY });
}
export const onRequest = (ctx) => (ctx.request.method === 'GET' ? onRequestGet(ctx) : json({ error: 'GET only' }, 405));
