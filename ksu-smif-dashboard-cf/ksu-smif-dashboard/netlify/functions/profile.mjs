// GET /api/profile?symbol=AAPL   -> fundamentals (sector, P/E, margins, beta, etc.)
// GET /api/profile?q=apple       -> ticker search for the screener's autocomplete
import { cleanSymbol, json, search, summary } from '../lib/yahoo.mjs';

export default async (req) => {
  const u = new URL(req.url);
  const cache = {
    'cache-control': 'public, max-age=300',
    'netlify-cdn-cache-control': 'public, s-maxage=3600, stale-while-revalidate=7200',
  };
  try {
    const q = (u.searchParams.get('q') || '').trim();
    if (q) return json({ results: await search(q.slice(0, 40)) }, 200, cache);
    const s = cleanSymbol(u.searchParams.get('symbol'));
    if (!s) return json({ error: 'Pass ?symbol=AAPL or ?q=apple' }, 400);
    return json(await summary(s), 200, cache);
  } catch (e) {
    // Fundamentals are "nice to have": the dashboard still works from price history alone.
    return json({ error: String(e.message || e) }, 502);
  }
};

export const config = { path: '/api/profile' };
