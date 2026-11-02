/* Ledgerview page effects: scroll progress bar, hero glow, staggered card reveals. No dependencies. */
(() => {
  'use strict';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bar = document.createElement('div');
  bar.id = 'fx-progress'; bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);

  // scroll progress
  let tick = false;
  const update = () => {
    tick = false;
    const h = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = 'scaleX(' + (h > 0 ? Math.min(1, scrollY / h) : 0) + ')';
  };
  addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener('hashchange', () => setTimeout(update, 50));

  if (reduce) return;

  // stagger siblings in grids so cards arrive one after another instead of all at once
  const STAGGER = '.feat-grid,.sol-grid,.about-grid,.stat-row';
  document.querySelectorAll(STAGGER).forEach((grid) => {
    Array.from(grid.children).forEach((c, i) => { c.style.transitionDelay = (i * 80) + 'ms'; c.style.animationDelay = (i * 80 + 250) + 'ms'; });
  });
  // normalise stroke lengths so the icon draw-in works for any shape
  document.querySelectorAll('.feat-icon *').forEach((el) => el.setAttribute('pathLength', '1'));
  // solution cards are rendered by script.js later, so stagger them as they appear
  const sol = document.getElementById('sol-grid');
  if (sol) new MutationObserver(() => Array.from(sol.children).forEach((c, i) => { c.style.transitionDelay = (i * 60) + 'ms'; })).observe(sol, { childList: true });

  // cards: light follows the cursor
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest && e.target.closest('.feat-card,.sol-card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--cx', (e.clientX - r.left) + 'px');
    card.style.setProperty('--cy', (e.clientY - r.top) + 'px');
  }, { passive: true });
  // hero glow follows the pointer (updates CSS vars; cheap)
  document.addEventListener('pointermove', (e) => {
    const hero = e.target.closest && e.target.closest('.page-hero');
    if (!hero) return;
    const r = hero.getBoundingClientRect();
    hero.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    hero.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
})();
