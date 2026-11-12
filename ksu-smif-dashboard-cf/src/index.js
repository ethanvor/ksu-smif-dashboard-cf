// Cloudflare Worker entry point: serves the website from ./site and routes /api/* to the server code.
// (The same handlers in /functions also work if this repo is ever deployed as a Cloudflare Pages project.)
import * as market from '../functions/api/market.js';
import * as profile from '../functions/api/profile.js';
import * as portfolio from '../functions/api/portfolio.js';
import * as scrappy from '../functions/api/scrappy.js';
import * as prices from '../functions/api/prices.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const context = { request, env, waitUntil: (p) => ctx.waitUntil(p) };
    try {
      if (url.pathname === '/api/market') return request.method === 'GET' ? await market.onRequestGet(context) : new Response('Method not allowed', { status: 405 });
      if (url.pathname === '/api/profile') return request.method === 'GET' ? await profile.onRequestGet(context) : new Response('Method not allowed', { status: 405 });
      if (url.pathname === '/api/portfolio') return await portfolio.onRequest(context);
      if (url.pathname === '/api/scrappy') return await scrappy.onRequest(context);
      if (url.pathname === '/api/prices') return await prices.onRequest(context);
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    // Link-preview robots (iMessage/Notes, Discord, Slack, LinkedIn, X, WhatsApp…) get a tiny page with just the
    // preview tags. Apple's previewer loads the full page in a browser and gives up if it's slow (the dashboard pulls
    // ~2 MB of chart/Excel libraries), so it would show a bare link even though the tags are there.
    if ((url.pathname === '/' || url.pathname === '/index.html') && request.method === 'GET' && isPreviewBot(request.headers.get('user-agent') || '')) {
      return new Response(PREVIEW_HTML(url), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
    }
    // everything else: the static website
    return env.ASSETS.fetch(request);
  },
};

const BOTS = /facebookexternalhit|facebot|twitterbot|discordbot|slackbot|slack-imgproxy|linkedinbot|whatsapp|telegrambot|skypeuripreview|teams|redditbot|embedly|pinterest|applebot|iframely|vkshare|google-inspectiontool|bingpreview|mastodon|signal/i;
const isPreviewBot = (ua) => BOTS.test(ua);
const SITE = 'https://smif.ksusmif.workers.dev';
const PREVIEW_HTML = (url) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>KSU SMIF · Portfolio Dashboard</title>
<meta name="description" content="Kennesaw State University Student Managed Investment Fund — live performance vs the S&amp;P 500, sector weights, risk and a trade simulator.">
<link rel="canonical" href="${SITE}/">
<link rel="icon" href="${SITE}/img/apple-touch-icon.png">
<link rel="apple-touch-icon" href="${SITE}/img/apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="KSU SMIF">
<meta property="og:title" content="KSU SMIF · Portfolio Dashboard">
<meta property="og:description" content="Kennesaw State University Student Managed Investment Fund — live performance vs the S&amp;P 500, sector weights, risk and a trade simulator.">
<meta property="og:url" content="${SITE}/">
<meta property="og:image" content="${SITE}/img/og-image.png">
<meta property="og:image:secure_url" content="${SITE}/img/og-image.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="KSU SMIF Portfolio Dashboard">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="KSU SMIF · Portfolio Dashboard">
<meta name="twitter:description" content="Live performance vs the S&amp;P 500, sector weights, risk and a trade simulator.">
<meta name="twitter:image" content="${SITE}/img/og-image.png">
</head><body><h1>KSU SMIF · Portfolio Dashboard</h1><p><a href="${SITE}/">Open the dashboard</a></p><img src="${SITE}/img/og-image.png" alt="KSU SMIF Portfolio Dashboard" width="1200" height="630"></body></html>`;
