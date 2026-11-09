// GET /api/profile?symbol=AAPL   -> fundamentals (sector, P/E, margins, beta, market cap, etc.)
// GET /api/profile?q=apple       -> ticker search for the screener's autocomplete
//
// Market cap must always show up within ~5 seconds, so it has a chain of sources:
//   1. Yahoo quoteSummary (full fundamentals)          — waited on for up to 3.5 s
//   2. Yahoo v7 quote (lighter endpoint, run in parallel) — market cap / shares outstanding
//   3. the last good copy saved in KV (shares outstanding × today's price is recomputed in the browser)
//   4. SEC EDGAR shares outstanding (US filers), × today's price in the browser
import { cleanSymbol, json, search, summary, quote } from '../../lib/yahoo.js';

const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const SEC_UA = { 'user-agent': 'KSU SMIF Dashboard (smif.ksusmif.workers.dev)', accept: 'application/json' };

async function secShares(sym, env) {
  let map = env?.SMIF_KV ? await env.SMIF_KV.get('sec-tickers', 'json').catch(() => null) : null;
  if (!map) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_UA });
    if (!r.ok) throw new Error('SEC list ' + r.status);
    map = {}; Object.values(await r.json()).forEach((x) => { map[x.ticker] = x.cik_str; });
    if (env?.SMIF_KV) await env.SMIF_KV.put('sec-tickers', JSON.stringify(map), { expirationTtl: 30 * 86400 }).catch(() => {});
  }
  const cik = map[sym] ?? map[sym.replace('.', '-')];
  if (!cik) throw new Error('not an SEC filer');
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/dei/EntityCommonStockSharesOutstanding.json`, { headers: SEC_UA });
  if (!r.ok) throw new Error('SEC shares ' + r.status);
  const rows = (await r.json())?.units?.shares || [];
  const last = rows.sort((a, b) => (a.end < b.end ? -1 : 1)).slice(-1)[0];
  if (!last?.val) throw new Error('no SEC shares');
  return { sharesOutstanding: last.val, sharesAsOf: last.end };
}

export async function onRequestGet({ request, env, waitUntil }) {
  const u = new URL(request.url);
  let cache;
  try { cache = caches.default; const hit = await cache.match(request); if (hit) return hit; } catch { cache = null; }
  const q = (u.searchParams.get('q') || '').trim();
  if (q) {
    try {
      const res = json({ results: await search(q.slice(0, 40)) }, 200, { 'cache-control': 'public, max-age=300, s-maxage=3600' });
      if (cache) waitUntil(cache.put(request, res.clone()));
      return res;
    } catch (e) { return json({ error: String(e.message || e) }, 502); }
  }
  const s = cleanSymbol(u.searchParams.get('symbol'));
  if (!s) return json({ error: 'Pass ?symbol=AAPL or ?q=apple' }, 400);
  const kv = env?.SMIF_KV, key = 'prof/' + s;

  const fullP = summary(s), quickP = quote(s);
  let secP = null; const sec = () => { if (!secP) { secP = secShares(s, env); secP.catch(() => {}); } return secP; };
  const early = setTimeout(sec, 2000); // if Yahoo is slow, start the SEC lookup early so it's ready by the deadline
  fullP.catch(() => {}); quickP.catch(() => {});
  let out = null, src = [];
  try { out = await within(fullP, 3000); src.push('Yahoo'); } catch { /* fall through */ }
  if (out?.marketCap == null) {
    try {
      const qk = await within(quickP, out ? 600 : 1000);
      out = out ? { ...out, marketCap: qk.marketCap, sharesOutstanding: out.sharesOutstanding ?? qk.sharesOutstanding } : qk;
      src.push('Yahoo quote');
    } catch { /* fall through */ }
  }
  let saved = null;
  if (out?.marketCap == null || !out) saved = kv ? await kv.get(key, 'json').catch(() => null) : null;
  if (!out && saved) { out = { ...saved, stale: saved.savedAt }; src = ['saved copy']; }
  else if (out && out.marketCap == null && saved?.sharesOutstanding) { out.sharesOutstanding = out.sharesOutstanding ?? saved.sharesOutstanding; src.push('saved shares'); }
  if (!out?.marketCap && !out?.sharesOutstanding) {
    try { const sec2 = await within(sec(), 800); out = { symbol: s, ...(out || {}), ...sec2 }; src.push('SEC'); } catch { /* none left */ }
  }
  clearTimeout(early);
  if (secP) secP.catch(() => {});
  if (!out) return json({ error: 'Fundamentals unavailable right now', symbol: s }, 502, { 'cache-control': 'no-store' });
  out.capSource = src.join(' + ');
  // keep the last good full copy, so a slow day at Yahoo still has numbers
  if (kv && src[0] === 'Yahoo' && out.marketCap != null) waitUntil(kv.put(key, JSON.stringify({ ...out, savedAt: new Date().toISOString().slice(0, 10) }), { expirationTtl: 60 * 86400 }).catch(() => {}));
  const good = src[0] === 'Yahoo' && out.marketCap != null;
  const res = json(out, 200, { 'cache-control': good ? 'public, max-age=300, s-maxage=3600' : 'no-store' });
  if (cache && good) waitUntil(cache.put(request, res.clone()));
  return res;
}
