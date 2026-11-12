#!/usr/bin/env node
/**
 * A QA pass over the app on an Android TV emulator: every screen, every
 * direction from everything focusable, and a look at each screen's layout.
 *
 * It does what a tester with a remote does -- presses Up, Down, Left, Right and
 * Back and watches where focus goes -- and writes down whatever does not make
 * sense: a press that goes nowhere when there is somewhere to go, one that goes
 * the wrong way or leaps across the screen, focus landing on something you
 * cannot see or on nothing at all, controls no press ever reaches, a page that
 * scrolls sideways, text cut off, things drawn on top of each other.
 *
 * It never presses OK on anything it walks, so it never plays anything. An
 * arrow can still change a setting -- on 21 September Up and Down on a select
 * changed the account's subtitle language and saved it -- so every form value
 * on the page is read before each press, and any press that changes one is
 * undone at once and reported as the worst kind of finding. And it
 * only opens the screens listed in SCREENS -- each one a single ordinary page
 * load, the same requests a person browsing would make. It does not sweep the
 * provider.
 *
 * Needs the app running on the emulator with its WebView forwarded:
 *
 *   adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>
 *   node tools/qa/tv-walk.js --port 9223 --out <dir> [--only tv,movies] [--nodes 40]
 *
 * Writes <dir>/findings.json and a screenshot per screen. The findings are
 * suspicions, not verdicts: each is for a person (or Claude) to look at against
 * the screenshot and the design boards, and the report is written from that.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '../../frontend/node_modules/ws'));

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, word, i, all) => {
    if (word.startsWith('--')) pairs.push([word.slice(2), all[i + 1]]);
    return pairs;
  }, [])
);
const PORT = Number(args.port ?? 9223);
const OUT = path.resolve(args.out ?? 'qa-out');
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const MAX_NODES = Number(args.nodes ?? 40);
const SETTLE_MS = 350;

/**
 * The screens, and how to reach each state from a fresh load of its URL.
 * `setup` is a list of key presses made after the page has focused something.
 */
// OK is only ever pressed through `ok:`, which names what must have focus. On
// 21 September the guide's setup pressed a bare Enter after a focus that had
// silently failed -- the button was not drawn yet -- and the press landed on
// the HRT card under it and played the channel.
// "Browse the guide" opens the first category itself, so this is the only OK
// any setup presses.
const GUIDE = ['text:Browse the guide', 'ok:text:Browse the guide', 'wait:5000'];
const FILMS = ['text:Browse film categories', 'ok:text:Browse film categories', 'wait:5000'];

const SCREENS = [
  { id: 'for-you', url: '/for-you' },
  { id: 'for-you-nav', url: '/for-you', setup: ['ArrowLeft*'] },
  { id: 'tv', url: '/tv' },
  // Into a category the way a remote gets there. One category, once.
  { id: 'tv-guide', url: '/tv', setup: GUIDE },
  { id: 'tv-guide-categories', url: '/tv', setup: [...GUIDE, 'ArrowLeft*'] },
  { id: 'tv-guide-nav', url: '/tv', setup: [...GUIDE, 'ArrowLeft*', 'ArrowLeft'] },
  { id: 'movies', url: '/movies' },
  { id: 'movies-grid', url: '/movies', setup: FILMS },
  { id: 'movies-grid-categories', url: '/movies', setup: [...FILMS, 'ArrowLeft*'] },
  { id: 'shows', url: '/shows' },
  // A show's page, by its address rather than by pressing OK on a card: a
  // card in "continue watching" may resume an episode, and nothing here plays.
  { id: 'series-detail', url: 'series-from:/shows' },
  { id: 'search', url: '/search?q=sport' },
  { id: 'search-arriving', url: '/search' },
  { id: 'search-narrowed', url: '/search?q=sport&in=vod' },
  // Round 6 (18 October): TMDB's pages, each by its address. Mercy and the
  // Matrix collection are titles this library has; nothing here plays.
  { id: 'film', url: '/film/1236153' },
  { id: 'film-copies', url: '/film/1236153/copies' },
  { id: 'film-collection', url: '/film/collection/2344' },
  { id: 'popular-films', url: '/for-you/popular/movie' },
  { id: 'popular-shows', url: '/for-you/popular/tv' },
  { id: 'top-films', url: '/discover/movie/top' },
  { id: 'genre-films', url: '/discover/movie/genre-35' },
  { id: 'genre-shows-top', url: '/discover/tv/genre-80-top' },
  { id: 'account-lock', url: '/account?section=lock' },
  { id: 'guides', url: '/guides' },
  { id: 'account', url: '/account' }
];

const KEYS = {
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27
};
const OPPOSITE = { ArrowLeft: 'ArrowRight', ArrowRight: 'ArrowLeft', ArrowUp: 'ArrowDown', ArrowDown: 'ArrowUp' };
const DIRECTIONS = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the device

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
let currentScreen = null;

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise(resolve => ws.on('open', resolve));
  ws.on('message', data => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails;
      consoleErrors.push({ screen: currentScreen, text: d.exception?.description?.split('\n')[0] ?? d.text });
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      const text = message.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300);
      consoleErrors.push({ screen: currentScreen, text });
    }
  });
  // Back from For You closes the app, and its page with it: answer whatever
  // was waiting, so the walk notices and starts the app again. Left waiting,
  // nothing kept node alive and it ended there without a word (26 October).
  ws.on('close', () => {
    for (const answer of pending.values()) {
      answer({ result: { exceptionDetails: { exception: { description: 'the page went away' } } } });
    }
    pending.clear();
  });
  await send('Runtime.enable');
  await send('Page.enable');
}

function send(method, params = {}) {
  // A message to a closed page is dropped without a word, and its answer never comes.
  if (ws.readyState !== WebSocket.OPEN) {
    return Promise.resolve({ result: { exceptionDetails: { exception: { description: 'the page went away' } } } });
  }
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(resolve => pending.set(id, resolve));
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return reply.result?.result?.value;
}

/**
 * The app's words for a control, in the language the page is in: setup steps
 * name controls in English ("Browse the guide"), and a walk in German would
 * otherwise find none of them (12 November). Words that are not the app's own
 * come back as they are.
 */
const I18N = path.join(__dirname, '..', '..', 'frontend', 'src', 'app', 'i18n');
const dictionaries = new Map();
const dictionary = lang => {
  if (!dictionaries.has(lang)) {
    let words = {};
    try {
      words = JSON.parse(fs.readFileSync(path.join(I18N, `${lang}.json`), 'utf8'));
    } catch {
      // A language without a file: English is all there is to match.
    }
    dictionaries.set(lang, words);
  }
  return dictionaries.get(lang);
};
const pathsTo = (entry, wanted, at = []) =>
  typeof entry === 'string'
    ? entry === wanted ? [at] : []
    : Object.entries(entry ?? {}).flatMap(([key, inner]) => pathsTo(inner, wanted, [...at, key]));
async function inPageLanguage(english) {
  const lang = await evaluate('document.documentElement.lang');
  if (!lang || lang === 'en') return english;
  const [found] = pathsTo(dictionary('en'), english);
  const translated = found?.reduce((entry, key) => entry?.[key], dictionary(lang));
  return typeof translated === 'string' ? translated : english;
}

/**
 * OK, but only on the thing named. Anything else aborts the screen: a stray OK
 * on a card plays it, and nothing here may play.
 */
async function pressOk(expect) {
  const wanted = expect.startsWith('text:') ? await inPageLanguage(expect.slice(5)) : '';
  const check = expect.startsWith('text:')
    ? `(() => { const a = document.activeElement; return !!a && a !== document.body && !a.closest('[data-focus-key^="recent-"], [data-focus-key^="fy-"], [data-focus-key^="guide-"], [data-focus-key^="prog-"], [data-focus-key^="favourite-"], [data-focus-key^="search-"]') && (a.innerText || '').includes(${JSON.stringify(wanted)}); })()`
    : 'false';
  if (!(await evaluate(check))) {
    throw new Error(`refused OK: focus is not on ${expect}`);
  }
  await press('Enter', true);
}

async function press(key, allowed = false) {
  if (key === 'Enter' && !allowed) {
    throw new Error('refused a bare Enter; use ok:<what must have focus>');
  }
  const base = { key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key] };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  if (key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(SETTLE_MS);
}

/** Android's Back, which is not a key the page sees: it goes through Capacitor. */
async function androidBack() {
  execFileSync('adb', ['shell', 'input', 'keyevent', '4']);
  await sleep(700);
}

/**
 * Stops everything if anything is playing. Belt and braces with the OK guard:
 * a player the walk started means a live connection to the provider, which
 * allows one, and a rule broken -- so the run ends there, the player is
 * closed, and what was found so far is written out.
 */
async function stopIfPlaying(where) {
  const audio = execFileSync('adb', ['shell', 'dumpsys', 'audio']).toString();
  const playing = audio.split(String.fromCharCode(10)).some(line => line.includes('AudioPlaybackConfiguration') && line.includes('state:started'));
  if (!playing) return;
  execFileSync('adb', ['shell', 'input', 'keyevent', '4']);
  find(currentScreen, 'high', 'walk-started-playback', `something started playing at ${where}; the walk stopped and pressed Back`);
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ findings, consoleErrors }, null, 2));
  console.log(`STOPPED: playback started at ${where}`);
  process.exit(2);
}

async function screenshot(name) {
  const reply = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(reply.result.data, 'base64'));
}

// ------------------------------------------------------ what runs in the page

/**
 * Installed once per page load. Everything the walk asks about the screen goes
 * through `window.__qa`, so each question is one round trip.
 */
const PAGE_HELPERS = String.raw`
(() => {
  const FOCUSABLE = 'a[href]:not([tabindex="-1"]),button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,video[controls],[tabindex]:not([tabindex="-1"])';

  const shown = el => {
    if (!el || !el.isConnected || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.visibility === 'hidden' || Number(s.opacity) < 0.05 || s.display === 'none') return false;
    }
    // Clipped away by an ancestor that does not scroll?
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = a.getBoundingClientRect();
      if (r.right <= c.left + 1 || r.left >= c.right - 1 || r.bottom <= c.top + 1 || r.top >= c.bottom - 1) {
        const scrolls = /(auto|scroll)/.test(s.overflowX + s.overflowY);
        if (!scrolls) return false;
      }
    }
    return true;
  };

  const inViewport = r => r.right > 1 && r.bottom > 1 && r.left < innerWidth - 1 && r.top < innerHeight - 1;

  const label = el => {
    const text = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.value || '')
      .replace(/\s+/g, ' ').trim();
    return text.slice(0, 50);
  };

  // A name that survives re-rendering: the item's focus key, plus which control
  // inside it; failing that, its text and roughly where it is.
  const sig = el => {
    const holder = el.closest('[data-focus-key]');
    if (holder) {
      const inside = [...holder.querySelectorAll(FOCUSABLE)];
      return holder === el ? 'key:' + holder.dataset.focusKey : 'key:' + holder.dataset.focusKey + '#' + inside.indexOf(el);
    }
    // Two Refresh buttons share a label, so count which one this is.
    const base = el.tagName.toLowerCase() + ':' + label(el).slice(0, 30);
    const twins = [...document.querySelectorAll(FOCUSABLE)].filter(e => !e.closest('[data-focus-key]') && e.tagName === el.tagName && label(e).slice(0, 30) === label(el).slice(0, 30));
    return twins.length > 1 ? base + '@' + twins.indexOf(el) : base;
  };

  const scope = () => {
    const all = document.querySelectorAll('[data-focus-scope]');
    return all.length ? all[all.length - 1] : document;
  };

  const rectOf = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };

  // Is there anything on it that says "you are here"? Outline, a ring drawn as
  // a shadow, or the same on the item that holds it -- or the white fill the
  // player's pieces wear for focus since round 14 (a pill, a chip, a row): a
  // background as light as the page's words.
  const lightFill = s => {
    // The tokens are oklch, and Chromium reports them as written.
    const ok = /oklch\(([\d.]+)%?\s+[\d.]+\s+[\d.]+(?:\s*\/\s*([\d.]+))?\)/.exec(s.backgroundColor);
    if (ok) {
      const l = parseFloat(ok[1]) > 1 ? parseFloat(ok[1]) / 100 : parseFloat(ok[1]);
      return l > 0.85 && (ok[2] === undefined || parseFloat(ok[2]) >= 0.9);
    }
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s.backgroundColor);
    if (!m || (m[4] !== undefined && parseFloat(m[4]) < 0.9)) return false;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255 > 0.8;
  };
  const ring = el => {
    for (const a of [el, el.closest('[data-focus-key]')].filter(Boolean)) {
      const s = getComputedStyle(a);
      if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) return true;
      if (s.boxShadow && s.boxShadow !== 'none') return true;
      if (lightFill(s)) return true;
    }
    return false;
  };

  const describe = el => {
    if (!el || el === document.body || el === document.documentElement) return null;
    return { sig: sig(el), tag: el.tagName.toLowerCase(), label: label(el), rect: rectOf(el), shown: shown(el),
             inViewport: inViewport(el.getBoundingClientRect()), ring: ring(el) };
  };

  const state = () => {
    const columns = document.querySelector('[data-tv-columns]');
    const scopes = [...document.querySelectorAll('[data-focus-scope]')].map(s => s.getAttribute('data-focus-scope') || s.tagName.toLowerCase());
    return location.pathname + location.search + '|' + (columns ? columns.dataset.drawer : '-') + '|' + scopes.join(',');
  };

  const candidates = () => [...scope().querySelectorAll(FOCUSABLE)].filter(shown).filter(el => inViewport(el.getBoundingClientRect()));

  window.__qa = {
    state,
    active: () => describe(document.activeElement),
    // Everything a press could reach from here, and the ones that lie in each direction.
    around: () => {
      const a = document.activeElement;
      const from = a && a !== document.body ? a.getBoundingClientRect() : null;
      const list = candidates().filter(el => el !== a);
      const ahead = { ArrowRight: 0, ArrowLeft: 0, ArrowDown: 0, ArrowUp: 0 };
      if (from) {
        for (const el of list) {
          const r = el.getBoundingClientRect();
          if (a.contains(el) || el.contains(a)) continue;
          if (r.left >= from.right - 2) ahead.ArrowRight++;
          if (r.right <= from.left + 2) ahead.ArrowLeft++;
          if (r.top >= from.bottom - 2) ahead.ArrowDown++;
          if (r.bottom <= from.top + 2) ahead.ArrowUp++;
        }
      }
      return ahead;
    },
    all: () => candidates().map(describe),
    focus: s => {
      const el = [...scope().querySelectorAll(FOCUSABLE)].find(e => sig(e) === s && shown(e));
      if (!el) return false;
      // As the remote arrives on a field: held back, read-only until OK.
      // Focused plainly, a field keeps its arrows for the caret, and the walk
      // reported controls beside it as unreachable when a remote reaches them.
      if (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)) el.readOnly = true;
      el.focus({ preventScroll: false });
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return document.activeElement === el;
    },
    // Every form control's value, so a press that changes one can be undone.
    values: () => ({ path: location.pathname, list: [...document.querySelectorAll('select, input')].map((el, i) =>
      [i, el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value]) }),
    restoreValues: ({ path, list: before }) => {
      // Only on the page they were read from: indexes mean nothing on another.
      if (location.pathname !== path) return [];
      const all = [...document.querySelectorAll('select, input')];
      const changed = [];
      for (const [i, value] of before) {
        const el = all[i];
        if (!el) continue;
        const now = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
        if (now === value) continue;
        changed.push((el.id || el.name || el.tagName.toLowerCase()) + ': ' + JSON.stringify(value) + ' -> ' + JSON.stringify(now));
        if (typeof value === 'boolean') el.checked = value; else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return changed;
    },
    focusSelector: q => { const el = document.querySelector(q); if (!el) return false; el.focus(); return document.activeElement === el; },
    rectOfSig: s => { const el = [...document.querySelectorAll(FOCUSABLE)].find(e => sig(e) === s); return el ? rectOf(el) : null; },
    // Things wrong with the screen as it stands, independent of focus.
    layout: () => {
      const issues = [];
      const doc = document.scrollingElement;
      if (doc.scrollWidth > innerWidth + 1) issues.push({ kind: 'page-scrolls-sideways', detail: 'page is ' + doc.scrollWidth + 'px wide in a ' + innerWidth + 'px window' });
      for (const el of document.querySelectorAll('body *')) {
        if (!(el instanceof HTMLElement) || !shown(el)) continue;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        // Off the right or bottom edge of the window with nothing to scroll to it.
        if (r.right > innerWidth + 2 && r.left < innerWidth) {
          let clipped = false;
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const as = getComputedStyle(a);
            if (as.overflowX !== 'visible') { clipped = true; break; }
          }
          if (!clipped) issues.push({ kind: 'past-right-edge', detail: label(el) || el.tagName.toLowerCase(), rect: rectOf(el) });
        }
        // Text cut off with no ellipsis to say so.
        if (el.childElementCount === 0 && (el.innerText || '').trim().length > 0 && s.overflowX !== 'visible'
            && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && s.webkitLineClamp === 'none'
            && el.tagName !== 'INPUT' && el.tagName !== 'SELECT') {
          issues.push({ kind: 'text-cut-off', detail: label(el), rect: rectOf(el) });
        }
        // Text too small to read from a sofa: under 22 design pixels on a 1080 board.
        if (el.childElementCount === 0 && (el.innerText || '').trim().length > 1) {
          const designPx = parseFloat(s.fontSize) * (1920 / innerWidth);
          if (designPx < 21.5 && inViewport(r)) issues.push({ kind: 'small-text', detail: Math.round(designPx) + 'px: ' + label(el), rect: rectOf(el) });
        }
      }
      // Focusable things drawn on top of each other.
      const f = candidates();
      for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) {
        const a = f[i], b = f[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox > 4 && oy > 4 && ox * oy > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) {
          issues.push({ kind: 'overlap', detail: label(a) + ' / ' + label(b), rect: rectOf(a) });
        }
      }
      // Rows of cards that stop well short of the right edge, not scrolling.
      for (const row of document.querySelectorAll('[data-tv-rail], [data-search-row]')) {
        if (!shown(row) || row.children.length < 3) continue;
        const rr = row.getBoundingClientRect();
        const last = [...row.children].filter(shown).pop();
        if (!last) continue;
        const gap = rr.right - last.getBoundingClientRect().right;
        if (row.scrollWidth <= row.clientWidth + 1 && gap > rr.width * 0.2) {
          issues.push({ kind: 'row-stops-short', detail: Math.round(gap) + 'px empty at the end of a ' + Math.round(rr.width) + 'px row', rect: rectOf(row) });
        }
      }
      // More than one thing marked as the current one.
      const current = [...document.querySelectorAll('[aria-current="true"], [aria-current="page"]')].filter(shown);
      const groups = new Map();
      for (const el of current) { const g = el.parentElement?.closest('ul,nav,[role=list],[data-focus-scope]') ?? document.body; groups.set(g, (groups.get(g) ?? 0) + 1); }
      for (const n of groups.values()) if (n > 1) issues.push({ kind: 'two-current', detail: n + ' items marked current in one list' });
      return issues;
    }
  };
  return true;
})()
`;

// ------------------------------------------------------------------ the walk

const findings = [];
function find(screen, severity, kind, detail, extra = {}) {
  findings.push({ screen, severity, kind, detail, ...extra });
}

async function waitForFocus(ms = 6000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const active = await evaluate('window.__qa ? window.__qa.active() : null').catch(() => null);
    if (active) return active;
    await sleep(250);
  }
  return null;
}

async function install() {
  // The page may still be booting; keep installing until it takes.
  for (let i = 0; i < 20; i++) {
    if (await evaluate(PAGE_HELPERS).catch(() => false)) return;
    await sleep(300);
  }
}

/** A move within the app, as a link would make it: the router, not a reload. */
async function go(url) {
  await evaluate(`history.pushState({ navigationId: Date.now() }, '', ${JSON.stringify(url)});
    dispatchEvent(new PopStateEvent('popstate', { state: { navigationId: Date.now() } })); true`);
  await sleep(2500);
}

/**
 * Every screen starts from a fresh load of For You and is then moved to the way
 * a person moves, so Back has somewhere to go and arrival is an arrival.
 */
async function load(screen) {
  await evaluate(`location.href = '/for-you'; true`).catch(() => {});
  await sleep(2500);
  await install();
  await waitForFocus();
  let url = screen.url;
  if (url.startsWith('series-from:')) {
    await go(url.slice('series-from:'.length));
    const key = await evaluate(`document.querySelector('main [data-focus-key*="series-"]')?.dataset.focusKey ?? null`);
    url = key ? '/series/' + key.split('-').pop() : null;
    if (!url) return null;
  }
  if (url !== '/for-you') await go(url);
  const landed = await waitForFocus(4000);
  for (const step of screen.setup ?? []) {
    if (step.startsWith('ok:')) {
      await pressOk(step.slice(3));
    } else if (step.startsWith('wait:')) {
      await sleep(Number(step.slice(5)));
    } else if (step.startsWith('text:')) {
      // Wait for it to be drawn and enabled rather than trying once: "Browse the
      // guide" is disabled until the categories have loaded.
      let focusedIt = false;
      const wanted = await inPageLanguage(step.slice(5));
      for (let i = 0; i < 60 && !focusedIt; i++) {
        focusedIt = await evaluate(`(() => { const b = [...document.querySelectorAll('main button, main a')].find(b => b.innerText.includes(${JSON.stringify(wanted)})); b?.focus(); return !!b && document.activeElement === b; })()`);
        if (!focusedIt) await sleep(250);
      }
      if (!focusedIt) throw new Error(`could not focus ${step.slice(5)}`);
      await sleep(200);
    } else if (step.startsWith('focus:')) {
      await evaluate(`window.__qa.focusSelector(${JSON.stringify(step.slice(6))})`);
      await sleep(200);
    } else if (step.endsWith('*')) {
      // Keep pressing until the state changes: Left from a card walks to the
      // row's first card before it opens anything.
      const key = step.slice(0, -1);
      const before = await evaluate('window.__qa.state()');
      for (let i = 0; i < 15; i++) {
        await press(key);
        if ((await evaluate('window.__qa.state()')) !== before) break;
      }
    } else {
      await press(step);
    }
  }
  if (screen.expectUrl) {
    await sleep(2500);
    await evaluate(PAGE_HELPERS).catch(() => {});
    await waitForFocus();
  }
  return landed;
}

async function walk(screen) {
  currentScreen = screen.id;
  console.log(`\n== ${screen.id}`);
  const landed = await load(screen);
  await stopIfPlaying(`${screen.id} setup`);
  const baseState = await evaluate('window.__qa.state()');
  if (screen.expectUrl && !baseState.includes(screen.expectUrl)) {
    find(screen.id, 'info', 'setup-failed', `could not reach ${screen.expectUrl}; state ${baseState}`);
    return;
  }

  if (!landed) {
    find(screen.id, 'high', 'nothing-focused-on-arrival', 'the screen opened with nothing focused, so the first press has nowhere to move from');
  }

  // Late enough for the fonts and the TV scale: an early capture drew text
  // squeezed into boxes sized for the next frame.
  await sleep(1500);
  await screenshot(`${screen.id}`);

  for (const issue of await evaluate('window.__qa.layout()')) {
    const severity = { 'page-scrolls-sideways': 'high', 'past-right-edge': 'medium', overlap: 'medium', 'text-cut-off': 'low',
      'small-text': 'low', 'row-stops-short': 'medium', 'two-current': 'medium' }[issue.kind] ?? 'low';
    find(screen.id, severity, issue.kind, issue.detail, { rect: issue.rect });
  }

  const everything = await evaluate('window.__qa.all()');
  const start = (await evaluate('window.__qa.active()')) ?? everything[0];
  if (!start) {
    find(screen.id, 'high', 'nothing-focusable', 'nothing on this screen can be focused');
    return;
  }

  const edges = [];
  const visited = new Set();
  const queue = [start.sig];
  const seen = new Set([start.sig]);
  let reloads = 0;

  const restore = async () => {
    if ((await evaluate('window.__qa.state()').catch(() => null)) === baseState) return true;
    // Cheap first: Escape closes a panel one level at a time.
    for (let i = 0; i < 3; i++) {
      await press('Escape');
      const now = await evaluate('window.__qa.state()').catch(() => null);
      if (now === baseState) return true;
    }
    reloads++;
    await load(screen);
    return (await evaluate('window.__qa.state()')) === baseState;
  };

  while (queue.length && visited.size < MAX_NODES) {
    const node = queue.shift();
    if (visited.has(node)) continue;
    if (!(await restore())) { find(screen.id, 'info', 'walk-cut-short', 'could not get back to the starting state'); break; }
    if (!(await evaluate(`window.__qa.focus(${JSON.stringify(node)})`))) continue;
    await sleep(150);
    visited.add(node);
    const from = await evaluate('window.__qa.active()');
    if (!from.ring) find(screen.id, 'medium', 'no-focus-ring', `nothing marks "${from.label}" as focused`, { at: from.sig, rect: from.rect });
    process.stdout.write('.');
    await stopIfPlaying(`${screen.id} ${node}`);

    for (const key of DIRECTIONS) {
      if (!(await restore())) break;
      if (!(await evaluate(`window.__qa.focus(${JSON.stringify(node)})`))) break;
      await sleep(120);
      const ahead = (await evaluate('window.__qa.around()'))[key];
      const values = await evaluate('window.__qa.values()');
      await press(key);
      const changed = await evaluate(`window.__qa.restoreValues(${JSON.stringify(values)})`).catch(() => []);
      for (const change of changed ?? []) {
        find(screen.id, 'high', 'arrow-changed-a-setting', `${key} from "${from.label}" changed ${change} (put back)`, { at: node, key });
      }
      const state = await evaluate('window.__qa.state()');
      const to = await evaluate('window.__qa.active()');
      const origin = (await evaluate(`window.__qa.rectOfSig(${JSON.stringify(node)})`)) ?? from.rect;
      const edge = { from: node, key, to: to?.sig ?? null, state: state === baseState ? null : state };
      edges.push(edge);

      if (!to) {
        find(screen.id, 'high', 'focus-lost', `${key} from "${from.label}" left focus on nothing`, { at: node, key });
      } else if (!to.shown || !to.inViewport) {
        find(screen.id, 'high', 'focus-invisible', `${key} from "${from.label}" put focus on "${to.label}", which is ${to.shown ? 'off the screen' : 'not visible'}`, { at: node, key, rect: to.rect });
      } else if (to.sig === node && state === baseState && ahead > 0) {
        find(screen.id, 'medium', 'dead-press', `${key} from "${from.label}" did nothing, with ${ahead} thing(s) that way`, { at: node, key });
      } else if (to.sig !== node && state === baseState) {
        const cx = r => r.x + r.w / 2, cy = r => r.y + r.h / 2;
        const dx = cx(to.rect) - cx(origin), dy = cy(to.rect) - cy(origin);
        const along = { ArrowRight: dx, ArrowLeft: -dx, ArrowDown: dy, ArrowUp: -dy }[key];
        const across = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
        const vw = await evaluate('[innerWidth, innerHeight]');
        if (along < -4) {
          find(screen.id, 'high', 'wrong-way', `${key} from "${from.label}" went the other way, to "${to.label}"`, { at: node, key });
        } else if (across > (key === 'ArrowRight' || key === 'ArrowLeft' ? vw[1] : vw[0]) * 0.35) {
          find(screen.id, 'medium', 'far-jump', `${key} from "${from.label}" jumped ${Math.round(across)}px sideways to "${to.label}"`, { at: node, key });
        }
      }

      if (to && state === baseState && !seen.has(to.sig)) {
        seen.add(to.sig);
        queue.push(to.sig);
      }
    }
  }
  process.stdout.write('\n');

  // Presses that do not come back: Right then Left should usually return.
  const lookup = new Map(edges.map(e => [e.from + '|' + e.key, e]));
  for (const e of edges) {
    if (!e.to || e.state || e.to === e.from) continue;
    const back = lookup.get(e.to + '|' + OPPOSITE[e.key]);
    if (back && !back.state && back.to && back.to !== e.from) {
      find(screen.id, 'low', 'no-way-back', `${e.key} then ${OPPOSITE[e.key]} from ${e.from} ends on ${back.to}`, { at: e.from, key: e.key });
    }
  }

  // Things on screen that no press reached -- only meaningful if the walk finished.
  if (!queue.length) {
    const reached = new Set([start.sig, ...edges.map(e => e.to).filter(Boolean)]);
    for (const el of everything) {
      if (!reached.has(el.sig)) find(screen.id, 'medium', 'unreachable', `"${el.label}" can be focused but no press reaches it`, { at: el.sig, rect: el.rect });
    }
  } else {
    find(screen.id, 'info', 'walk-capped', `walked ${visited.size} of ${seen.size}+ focusable things`);
  }

  // Where pressing an arrow takes you out of this screen.
  for (const e of edges.filter(x => x.state)) {
    find(screen.id, 'info', 'leaves-screen', `${e.key} from ${e.from} -> ${e.state}`, { at: e.from, key: e.key });
  }

  // Back, from where the screen started.
  await restore();
  const beforeBack = await evaluate('window.__qa.state()');
  await androidBack();
  const afterBack = await evaluate('window.__qa ? window.__qa.state() : location.pathname').catch(() => 'the app went away');
  const focus = await evaluate('window.__qa ? window.__qa.active() : null').catch(() => null);
  find(screen.id, 'info', 'back', `Back: ${beforeBack} -> ${afterBack}; focus on ${focus ? '"' + focus.label + '"' : 'nothing'}`);
  if (afterBack !== beforeBack && !focus) {
    find(screen.id, 'high', 'focus-lost-after-back', `Back from ${screen.id} landed with nothing focused`);
  }
  const foreground = execFileSync('adb', ['shell', 'dumpsys window | grep mCurrentFocus']).toString();
  if (!foreground.includes('app.tvinto')) {
    find(screen.id, 'info', 'back-left-app', 'Back from here closed the app');
    execFileSync('adb', ['shell', 'am', 'start', '-n', 'app.tvinto/.MainActivity']);
    await sleep(6000);
    await reconnect();
  }
  if (reloads > 5) find(screen.id, 'info', 'reloads', `${reloads} reloads to get back to the start`);
  console.log(`   ${visited.size} walked, ${edges.length} presses`);
}

async function reconnect() {
  try { ws.close(); } catch {}
  const pid = execFileSync('adb', ['shell', 'pidof', 'app.tvinto']).toString().trim();
  execFileSync('adb', ['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  await connect();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await connect();
  for (const screen of SCREENS) {
    if (ONLY && !ONLY.has(screen.id)) continue;
    try {
      await walk(screen);
    } catch (error) {
      find(screen.id, 'info', 'walker-error', String(error.message ?? error).slice(0, 300));
      console.log(`   walker error: ${error.message}`);
    }
    fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ findings, consoleErrors }, null, 2));
  }
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ findings, consoleErrors }, null, 2));
  const count = s => findings.filter(f => f.severity === s).length;
  console.log(`\n${findings.length} findings: ${count('high')} high, ${count('medium')} medium, ${count('low')} low; ${consoleErrors.length} console errors`);
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
