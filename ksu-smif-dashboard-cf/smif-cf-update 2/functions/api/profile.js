// GET /api/profile?symbol=AAPL   -> fundamentals (sector, P/E, margins, beta, etc.)
// GET /api/profile?q=apple       -> ticker search for the screener's autocomplete
import { cleanSymbol, json, search, summary } from '../../lib/yahoo.js';

export async function onRequestGet({ request, waitUntil }) {
  const u = new URL(request.url);
  let cache;
  try { cache = caches.default; const hit = await cache.match(request); if (hit) return hit; } catch { cache = null; }
  const headers = { 'cache-control': 'public, max-age=300, s-maxage=3600' };
  try {
    const q = (u.searchParams.get('q') || '').trim();
    let res;
    if (q) res = json({ results: await search(q.slice(0, 40)) }, 200, headers);
    else {
      const s = cleanSymbol(u.searchParams.get('symbol'));
      if (!s) return json({ error: 'Pass ?symbol=AAPL or ?q=apple' }, 400);
      res = json(await summary(s), 200, headers);
    }
    if (cache) waitUntil(cache.put(request, res.clone()));
    return res;
  } catch (e) {
    // Fundamentals are "nice to have": the dashboard still works from price history alone.
    return json({ error: String(e.message || e) }, 502);
  }
}
