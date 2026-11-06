// GET /api/market?symbols=AAPL,MSFT,SPY&range=1y              (daily)
// GET /api/market?symbols=AAPL,SPY&range=10y&interval=1wk     (weekly, for 3Y/5Y/10Y charts)
// GET /api/market?symbols=AAPL,AGG&range=all&interval=1wk     (weekly since 2009, for the Performance tab)
// Cloudflare Pages Function. Responses are cached at Cloudflare's edge for 5 minutes,
// so many analysts opening the site at once only reach Yahoo once.
import { chart, cleanSymbol, json, pool } from '../../lib/yahoo.js';

const RANGES = new Set(['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'all']); // all = since 2009, weekly

export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url);
  const symbols = [...new Set((u.searchParams.get('symbols') || '').split(',').map(cleanSymbol).filter(Boolean))].slice(0, 40);
  const range = RANGES.has(u.searchParams.get('range')) ? u.searchParams.get('range') : '1y';
  const interval = u.searchParams.get('interval') === '1wk' ? '1wk' : '1d';
  if (!symbols.length) return json({ error: 'Pass ?symbols=AAPL,MSFT' }, 400);

  // edge cache (keyed by the normalized request)
  const cacheKey = new Request(`${u.origin}/api/market?symbols=${symbols.join(',')}&range=${range}&interval=${interval}`, { method: 'GET' });
  let cache;
  try { cache = caches.default; const hit = await cache.match(cacheKey); if (hit) return hit; } catch { cache = null; }

  const data = await pool(symbols, 6, (s) => chart(s, range, interval));
  const res = json({ range, interval, fetchedAt: new Date().toISOString(), data }, 200, { 'cache-control': 'public, max-age=60, s-maxage=300' });
  if (cache && data.some((d) => d && !d.error)) waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
