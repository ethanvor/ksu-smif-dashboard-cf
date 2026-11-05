// The shared MASTER copy of the SMIF portfolio, stored in Cloudflare KV (binding name: SMIF_KV).
//
//   GET  /api/portfolio                 -> current master (or {master:null} if never published)
//   GET  /api/portfolio?history=1       -> list of saved versions (newest first)
//   GET  /api/portfolio?version=<key>   -> one past version
//   PUT  /api/portfolio                 -> publish a new master  (header  x-admin-key: <ADMIN_KEY>)
//   POST /api/portfolio?check=1         -> verify a passcode without saving
//   GET  /api/portfolio?doc=history     -> trade history built from the Schwab transaction export
//   PUT  /api/portfolio?doc=history     -> replace it (passcode required)
//
// Anyone can READ. Only people with the passcode (secret ADMIN_KEY) can WRITE.
import { json } from '../../lib/yahoo.js';

const noCache = { 'cache-control': 'no-store' };

function authorized(request, env) {
  const key = env.ADMIN_KEY;
  if (!key) return false; // writes disabled until a passcode is configured
  const given = request.headers.get('x-admin-key') || '';
  if (given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function validate(p) {
  if (!p || typeof p !== 'object') return 'Body must be a portfolio object';
  if (!Array.isArray(p.holdings)) return 'holdings[] missing';
  if (p.holdings.length > 500) return 'Too many holdings';
  for (const h of p.holdings) {
    if (!h.ticker || typeof h.ticker !== 'string') return 'Every holding needs a ticker';
    if (!isFinite(+h.quantity)) return `Bad quantity for ${h.ticker}`;
  }
  if (!isFinite(+p.cash)) return 'cash must be a number';
  return null;
}

export async function onRequest({ request, env }) {
  const kv = env.SMIF_KV;
  if (!kv) return json({ error: 'Storage not connected: add a KV binding named SMIF_KV in Cloudflare Pages settings.' }, 500);
  const u = new URL(request.url);
  const method = request.method;

  // ---- trade history document ----
  if (u.searchParams.get('doc') === 'history') {
    if (method === 'GET') return json({ history: (await kv.get('tx-history', 'json')) || null }, 200, noCache);
    if (method === 'PUT') {
      if (!env.ADMIN_KEY) return json({ error: 'Writes are disabled: add an ADMIN_KEY secret in Cloudflare Pages settings.' }, 403);
      if (!authorized(request, env)) return json({ error: 'Wrong passcode' }, 401);
      let h;
      try { h = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      if (!h || typeof h.tickers !== 'object' || !Array.isArray(h.cashSeries)) return json({ error: 'Not a transaction history document' }, 400);
      h.publishedAt = new Date().toISOString();
      h.publishedBy = String(h.publishedBy || 'Admin').slice(0, 60);
      await kv.put('tx-history', JSON.stringify(h));
      return json({ ok: true, publishedAt: h.publishedAt }, 200, noCache);
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  if (method === 'GET') {
    if (u.searchParams.get('history')) {
      const { keys } = await kv.list({ prefix: 'history/' });
      const versions = keys.map((k) => ({ key: k.name, ...(k.metadata || {}) })).sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 100);
      return json({ versions }, 200, noCache);
    }
    const v = u.searchParams.get('version');
    if (v) {
      if (!v.startsWith('history/')) return json({ error: 'bad version key' }, 400);
      return json({ master: await kv.get(v, 'json') }, 200, noCache);
    }
    return json({ master: (await kv.get('master', 'json')) || null, writable: !!env.ADMIN_KEY }, 200, noCache);
  }

  if (method === 'POST' && u.searchParams.get('check')) {
    return json({ ok: authorized(request, env), configured: !!env.ADMIN_KEY }, 200, noCache);
  }

  if (method === 'PUT') {
    if (!env.ADMIN_KEY) return json({ error: 'Writes are disabled: add an ADMIN_KEY secret in Cloudflare Pages settings.' }, 403);
    if (!authorized(request, env)) return json({ error: 'Wrong passcode' }, 401);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const err = validate(body);
    if (err) return json({ error: err }, 400);
    const prev = await kv.get('master', 'json');
    const now = new Date().toISOString();
    body.meta = {
      ...(body.meta || {}),
      updatedAt: now,
      updatedBy: String(body.meta?.updatedBy || 'Admin').slice(0, 60),
      note: String(body.meta?.note || '').slice(0, 200),
      version: (prev?.meta?.version || 0) + 1,
    };
    const meta = { updatedAt: now, updatedBy: body.meta.updatedBy, note: body.meta.note, version: body.meta.version, holdings: body.holdings.length };
    const text = JSON.stringify(body);
    // keep every published version so any change can be rolled back
    await kv.put(`history/${now}`, text, { metadata: meta });
    await kv.put('master', text);
    return json({ ok: true, meta: body.meta }, 200, noCache);
  }

  return json({ error: 'Method not allowed' }, 405);
}
