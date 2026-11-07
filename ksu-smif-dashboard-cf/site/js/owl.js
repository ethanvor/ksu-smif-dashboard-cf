// Easter egg: a little 8-bit owl that flies a few laps around the screen.
// Triggers: click the KSU logo 3 times, type "owls" or "hoot", or (once a day) on its own ~40 s into a visit.
const K = '#1a1714', G = '#FFC629', D = '#c99200', W = '#ffffff', O = '#e8781f', E = '#1a1714';
const PAL = { K, G, D, W, O, E };
// 16×12 pixel maps, two wing positions
const UP = [
  '....K......K....',
  '...KGK....KGK...',
  'KK.KGGKKKKGGK.KK',
  'KDKKGWWGGWWGKKDK',
  'KDDKGWEGGEWGKDDK',
  '.KDKGGGOOGGGKDK.',
  '..KKGDGOOGDGKK..',
  '....KGDGGDGK....',
  '....KGGDDGGK....',
  '.....KGGGGK.....',
  '......KKKK......',
  '......O..O......',
];
const DOWN = [
  '....K......K....',
  '...KGK....KGK...',
  '...KGGKKKKGGK...',
  '...KGWWGGWWGK...',
  '...KGWEGGEWGK...',
  '.KKKGGGOOGGGKKK.',
  'KDDKGDGOOGDGKDDK',
  'KDK.KGDGGDGK.KDK',
  'KK..KGGDDGGK..KK',
  '.....KGGGGK.....',
  '......KKKK......',
  '......O..O......',
];
const svg = (map) => {
  let r = '';
  map.forEach((row, y) => [...row].forEach((c, x) => { if (PAL[c]) r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${PAL[c]}"/>`; }));
  return `<svg viewBox="0 0 16 12" width="48" height="36" shape-rendering="crispEdges" aria-hidden="true">${r}</svg>`;
};

let flying = false;
export function flyOwl(laps = 3) {
  if (flying || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  flying = true;
  const el = document.createElement('div');
  el.className = 'pix-owl';
  el.title = 'Hoot! Go Owls!';
  el.innerHTML = `<div class="f up">${svg(UP)}</div><div class="f down">${svg(DOWN)}</div>`;
  document.body.appendChild(el);
  const W0 = innerWidth, H0 = innerHeight, m = 60;
  // waypoints: in from the left, a few loops across the screen, out to the right
  const pts = [[-80, H0 * (0.25 + Math.random() * 0.4)]];
  for (let i = 0; i < laps * 3; i++) pts.push([m + Math.random() * (W0 - 2 * m), m + 40 + Math.random() * (H0 * 0.7 - m)]);
  pts.push([W0 + 80, H0 * (0.15 + Math.random() * 0.4)]);
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const cr = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3); };
  const at = (u) => { const n = P.length - 3, s = Math.max(0, Math.min(n - 1e-6, u * n)), i = Math.floor(s), t = s - i; return [cr(P[i][0], P[i + 1][0], P[i + 2][0], P[i + 3][0], t), cr(P[i][1], P[i + 1][1], P[i + 2][1], P[i + 3][1], t)]; };
  let len = 0, prev = at(0); for (let k = 1; k <= 400; k++) { const q = at(k / 400); len += Math.hypot(q[0] - prev[0], q[1] - prev[1]); prev = q; }
  const dur = Math.max(6000, (len / 280) * 1000); // ~280 px per second
  const t0 = performance.now();
  let last = at(0), face = 1;
  const step = (now) => {
    const u = Math.max(0, Math.min(1, (now - t0) / dur)); // rAF time can be a hair earlier than t0
    const [x, y] = at(u);
    if (Math.abs(x - last[0]) > 0.4) face = x > last[0] ? 1 : -1;
    const bob = Math.sin(now / 120) * 3;
    el.style.transform = `translate(${x - 24}px, ${y - 18 + bob}px) scaleX(${face})`;
    last = [x, y];
    if (u < 1 && el.isConnected) requestAnimationFrame(step); else { el.remove(); flying = false; }
  };
  requestAnimationFrame(step);
  el.addEventListener('click', () => {
    const b = document.createElement('div'); b.className = 'pix-hoot'; b.textContent = 'Hoot hoot! Go Owls!';
    b.style.left = `${last[0]}px`; b.style.top = `${last[1] - 40}px`;
    document.body.appendChild(b); setTimeout(() => b.remove(), 1600);
  });
}

// --- triggers ---
let clicks = [];
document.querySelector('.brand')?.addEventListener('click', () => {
  const now = Date.now(); clicks = clicks.filter((t) => now - t < 1500); clicks.push(now);
  if (clicks.length >= 3) { clicks = []; flyOwl(); }
});
let typed = '';
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  typed = (typed + (e.key || '').toLowerCase()).slice(-6);
  if (/owls$|hoot$/.test(typed)) { typed = ''; flyOwl(); }
});
try {
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem('smif.owlDay') !== today) {
    setTimeout(() => { if (document.visibilityState === 'visible') { localStorage.setItem('smif.owlDay', today); flyOwl(2); } }, 40000);
  }
} catch { /* private mode: no daily flight */ }
