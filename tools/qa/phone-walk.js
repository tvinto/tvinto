#!/usr/bin/env node
/**
 * A QA pass over the app on a phone emulator: every screen reached the way a
 * thumb reaches it, and each one looked over for what a tester would point at.
 *
 * The television's walk (tv-walk.js) is about where a D-pad press goes. A phone
 * has no D-pad, so this one is about what a finger meets instead: screens
 * opened by real taps (`adb shell input tap`, not events faked inside the
 * page), then checked for a page that scrolls sideways, text cut off without
 * an ellipsis, targets too small to hit, controls on top of each other, the
 * last thing on a page hidden under the tab bar, text too small to read, and a
 * keyboard that came up when nobody asked for one. Back is pressed on each.
 *
 * What it will not do, whatever a step says:
 * - tap anything inside a channel, film or show card -- a tap there plays it,
 *   on a provider that allows one connection;
 * - tap anything whose words say it changes something (sign out, remove,
 *   reset, refresh, save, play and so on);
 * and it stops the run if anything starts playing, and puts back any form
 * value a tap changed.
 *
 *   adb forward tcp:9224 localabstract:webview_devtools_remote_<pid>
 *   node tools/qa/phone-walk.js --serial emulator-5556 --port 9224 --out <dir> [--only tv,account]
 *
 * Writes <dir>/findings.json and a real screenshot per screen. The findings are
 * suspicions to check against the screenshot, not verdicts.
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
const SERIAL = args.serial ?? 'emulator-5556';
const PORT = Number(args.port ?? 9224);
const OUT = path.resolve(args.out ?? 'qa-phone');
const ONLY = args.only ? new Set(args.only.split(',')) : null;

const PLAYABLE = /^(guide-|prog-|recent-|fy-|stream-|search-|favourite-|series-|episode-)/;
const CHANGES_SOMETHING =
  /sign out|log out|remove|delete|unlink|reset|refresh|reload|load it again|turn off|save|change password|use my provider|\badd\b|download|install|play|watch|resume|restart|clear/i;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const adb = (...rest) => execFileSync('adb', ['-s', SERIAL, ...rest]).toString();

// ------------------------------------------------------------- the device

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
let currentScreen = null;
let webViewTop = 0;

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
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
      consoleErrors.push({ screen: currentScreen, text: message.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
    }
  });
  await send('Runtime.enable');
}

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise(resolve => pending.set(id, resolve));
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) {
    throw new Error(reply.result.exceptionDetails.exception?.description?.split('\n')[0] ?? 'evaluate failed');
  }
  return reply.result?.result?.value;
}

/** Where the WebView sits on the screen, which is where taps are aimed from. */
function measureWebView() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/qa-ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/qa-ui.xml');
  const match = /class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]/.exec(xml);
  if (!match) throw new Error('no WebView on screen');
  webViewTop = Number(match[2]);
}

function keyboardUp() {
  return /mInputShown=true/.test(adb('shell', 'dumpsys', 'input_method'));
}

function playing() {
  return adb('shell', 'dumpsys', 'audio')
    .split('\n')
    .some(line => line.includes('AudioPlaybackConfiguration') && line.includes('state:started'));
}

async function stopIfPlaying(where) {
  if (!playing()) return;
  adb('shell', 'input', 'keyevent', '4');
  find(currentScreen, 'high', 'walk-started-playback', `something started playing at ${where}; the walk stopped and pressed Back`);
  save();
  console.log(`STOPPED: playback started at ${where}`);
  process.exit(2);
}

async function screenshot(name) {
  adb('shell', 'screencap', '-p', '/sdcard/qa-shot.png');
  execFileSync('adb', ['-s', SERIAL, 'pull', '/sdcard/qa-shot.png', path.join(OUT, `${name}.png`)]);
}

/**
 * A real tap on whatever `expression` finds, after checking it is safe.
 * Returns the words on what was tapped, or null if nothing was.
 */
async function tap(expression, label) {
  const found = await evaluate(`(() => {
    const el = (${expression});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio,
      key: el.closest('[data-focus-key]')?.dataset.focusKey ?? '',
      words: (el.innerText || el.getAttribute('aria-label') || el.title || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
    };
  })()`);
  if (!found) {
    find(currentScreen, 'info', 'step-not-found', `could not find ${label}`);
    return null;
  }
  if (PLAYABLE.test(found.key)) throw new Error(`refused to tap a playable card (${found.key})`);
  if (CHANGES_SOMETHING.test(found.words)) throw new Error(`refused to tap "${found.words}"`);
  await sleep(250);
  const x = Math.round(found.x * found.dpr);
  const y = Math.round(webViewTop + found.y * found.dpr);
  adb('shell', 'input', 'tap', String(x), String(y));
  await sleep(1200);
  await stopIfPlaying(`tap on "${found.words}"`);
  return found.words || label;
}

async function back() {
  adb('shell', 'input', 'keyevent', '4');
  await sleep(1200);
}

function stillOpen() {
  return adb('shell', 'dumpsys window | grep mCurrentFocus').includes('app.tvinto');
}

// ------------------------------------------------------------ what it checks

const LAYOUT = String.raw`(() => {
  const issues = [];
  const shown = el => {
    if (!el.isConnected || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
    }
    return true;
  };
  const onScreen = r => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  const label = el => (el.getAttribute('aria-label') || el.title || el.innerText || el.placeholder || el.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 50);
  const box = r => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const scrollsX = el => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true; } return false; };

  if (document.scrollingElement.scrollWidth > innerWidth + 1) {
    issues.push({ severity: 'high', kind: 'page-scrolls-sideways', detail: 'the page is ' + document.scrollingElement.scrollWidth + 'px wide on a ' + innerWidth + 'px screen' });
  }

  // Only what a finger can reach: something under a sheet, or scrolled under
  // the tab bar, is covered at its centre by whatever is on top of it.
  const reachable = el => {
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const tappable = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, [role=button], [tabindex]:not([tabindex="-1"])')]
    .filter(shown).filter(el => onScreen(el.getBoundingClientRect())).filter(reachable);

  for (const el of tappable) {
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 2 && !scrollsX(el)) issues.push({ severity: 'medium', kind: 'off-the-right-edge', detail: label(el), rect: box(r) });
    // WCAG 2.2 AA: 24 by 24. A finger wants more; this is the floor.
    if (r.width < 24 || r.height < 24) issues.push({ severity: 'medium', kind: 'small-tap-target', detail: Math.round(r.width) + 'x' + Math.round(r.height) + ': ' + label(el), rect: box(r) });
  }

  for (let i = 0; i < tappable.length; i++) for (let j = i + 1; j < tappable.length; j++) {
    const a = tappable[i], b = tappable[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    // A small button laid wholly on a card's corner -- the phone's "···" -- is
    // a design, not a collision: both stay reachable.
    const inside = (small, big) => small.left >= big.left - 1 && small.right <= big.right + 1 && small.top >= big.top - 1 && small.bottom <= big.bottom + 1 && small.width * small.height < 0.25 * big.width * big.height;
    if (inside(ra, rb) || inside(rb, ra)) continue;
    // Content passing under the fixed tab bar as it scrolls is not a collision.
    if (!!a.closest('nav') !== !!b.closest('nav') && [a, b].some(el => el.closest('nav') && getComputedStyle(el.closest('nav')).position !== 'static')) continue;
    if (ox > 4 && oy > 4 && ox * oy > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) {
      issues.push({ severity: 'medium', kind: 'overlapping-targets', detail: label(a) + ' / ' + label(b), rect: box(ra) });
    }
  }

  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement) || el.childElementCount || !shown(el)) continue;
    const text = (el.innerText || '').trim();
    if (!text) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!onScreen(r)) continue;
    if (s.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== 'ellipsis' && s.webkitLineClamp === 'none' && !['INPUT', 'SELECT'].includes(el.tagName)) {
      issues.push({ severity: 'low', kind: 'text-cut-off', detail: text.slice(0, 50), rect: box(r) });
    }
    if (parseFloat(s.fontSize) < 12 && text.length > 1) issues.push({ severity: 'low', kind: 'small-text', detail: s.fontSize + ': ' + text.slice(0, 40), rect: box(r) });
  }

  // The last thing on a page, scrolled to the bottom, should clear the tab bar.
  const bar = [...document.querySelectorAll('nav')].find(n => shown(n) && n.getBoundingClientRect().bottom >= innerHeight - 2 && n.getBoundingClientRect().top > innerHeight / 2);
  const main = document.querySelector('main');
  if (bar && main) {
    const last = [...main.querySelectorAll('a[href], button, input, select, [role=button]')].filter(shown).pop();
    // Whatever scrolls it: For You scrolls a panel of its own inside <main>,
    // and scrolling <main> left the last tile where it was -- reported as
    // under the tab bar when, scrolled down, it cleared it by 100px (11 October).
    let scroller = null;
    for (let at = last?.parentElement; at && at !== document.body; at = at.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(at).overflowY) && at.scrollHeight > at.clientHeight) { scroller = at; break; }
    }
    scroller ??= main.scrollHeight > main.clientHeight ? main : document.scrollingElement;
    scroller.scrollTop = scroller.scrollHeight;
    const barTop = bar.getBoundingClientRect().top;
    if (last) {
      const r = last.getBoundingClientRect();
      if (r.bottom > barTop + 2 && r.top < innerHeight) issues.push({ severity: 'medium', kind: 'hidden-under-tab-bar', detail: label(last) + ' ends ' + Math.round(r.bottom - barTop) + 'px under the tab bar', rect: box(r) });
    }
    scroller.scrollTop = 0;
  }
  return issues;
})()`;

// Settings only: named selects and checkboxes, which outlive a screen change.
// A search field that goes away with its sheet is not a setting that changed.
const VALUES = `Object.fromEntries([...document.querySelectorAll('select[id], input[type=checkbox][id], input[type=radio][id]')].map(el => [el.id, el.type === 'select-one' ? el.value : el.checked]))`;
const changedSettings = (before, after) => Object.keys(before).filter(key => key in after && before[key] !== after[key]);

/** Where the app is, in words that differ between a library's front page and a category in it. */
const WHERE = `location.pathname + ' | ' + ([...document.querySelectorAll('[data-tv-title-row] [data-phone-only], main h1')].find(e => e.offsetParent)?.innerText.trim().slice(0, 40) ?? '') + (document.querySelector('[data-category-sheet]') ? ' +sheet' : '')`;

// -------------------------------------------------------------- the screens

const tab = name => `[...document.querySelectorAll('nav a')].find(a => a.innerText.trim() === '${name}' && a.offsetParent && a.getBoundingClientRect().top > innerHeight / 2)`;
const button = words => `[...document.querySelectorAll('main button, main a')].find(b => b.innerText.includes('${words}') && !b.disabled && b.offsetParent)`;
const categoryTitle = `[...document.querySelectorAll('[data-tv-title-row] [data-phone-only]')].find(e => e.offsetParent)`;
const sheetRow = n => `[...document.querySelectorAll('[data-category-sheet] [data-focus-key^=category-] button')][${n}]`;

/**
 * Each screen: how to get there from For You, and what to try once there.
 * `try` steps are taps whose result is checked by `expect`.
 */
const SCREENS = [
  { id: 'for-you', steps: [] },
  { id: 'tv', steps: [[tab('Live TV'), 'the Live TV tab']] },
  {
    id: 'tv-guide',
    steps: [[tab('Live TV'), 'the Live TV tab'], [button('Browse the guide'), 'Browse the guide']],
    try: [
      { tap: `[...document.querySelectorAll('main button')].find(b => /^On air/.test(b.innerText.trim()))`, label: 'the On air chip', expect: `true` },
      { tap: `[...document.querySelectorAll('main button')].find(b => /^All/.test(b.innerText.trim()))`, label: 'the All chip', expect: `true` }
    ]
  },
  {
    id: 'tv-category-sheet',
    steps: [[tab('Live TV'), 'the Live TV tab'], [button('Browse the guide'), 'Browse the guide'], [categoryTitle, 'the category title']],
    expectOpen: `!!document.querySelector('[data-category-sheet]')`,
    try: [{ tap: sheetRow(3), label: 'the fourth category', expect: `!document.querySelector('[data-category-sheet]')` }]
  },
  { id: 'movies', steps: [[tab('Movies'), 'the Movies tab']] },
  { id: 'movies-grid', steps: [[tab('Movies'), 'the Movies tab'], [button('Browse film categories'), 'Browse film categories']] },
  {
    id: 'movies-category-sheet',
    steps: [[tab('Movies'), 'the Movies tab'], [button('Browse film categories'), 'Browse film categories'], [categoryTitle, 'the category title']],
    expectOpen: `!!document.querySelector('[data-category-sheet]')`
  },
  { id: 'shows', steps: [[tab('Shows'), 'the Shows tab']] },
  { id: 'shows-grid', steps: [[tab('Shows'), 'the Shows tab'], [button('Browse show categories'), 'Browse show categories']] },
  { id: 'account', steps: [[`[...document.querySelectorAll('header a, header button')].find(e => e.getAttribute('href') === '/account' && e.offsetParent)`, 'the account button']] },
  // Guides is a row on Account on a phone (SR-P-3), its tab given to Search.
  {
    id: 'guides',
    steps: [
      [`[...document.querySelectorAll('header a, header button')].find(e => e.getAttribute('href') === '/account' && e.offsetParent)`, 'the account button'],
      ['document.querySelector("[data-account-guides]")', 'the Programme guides row']
    ]
  },
  // The tab raises the keyboard by itself, as a search tab does (SR-P-2).
  {
    id: 'search',
    steps: [[tab('Search'), 'the Search tab'], { type: 'sport' }],
    expectOpen: `location.pathname === '/search'`
  },
  { id: 'search-from-movies', steps: [[tab('Movies'), 'the Movies tab'], ['document.querySelector("[data-library-search]")', 'the Search films button']] }
];

// ------------------------------------------------------------------ the walk

const findings = [];
function find(screen, severity, kind, detail, extra = {}) {
  findings.push({ screen, severity, kind, detail, ...extra });
}
function save() {
  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ findings, consoleErrors }, null, 2));
}

async function home() {
  await evaluate(`location.href = '/for-you'; true`).catch(() => {});
  await sleep(4000);
  if (keyboardUp()) await back();
}

async function walk(screen) {
  currentScreen = screen.id;
  console.log(`== ${screen.id}`);
  await home();

  for (const step of screen.steps) {
    if (step.type) {
      adb('shell', 'input', 'text', step.type);
      adb('shell', 'input', 'keyevent', '66');
      await sleep(6000);
      if (keyboardUp()) await back();
      continue;
    }
    const [expression, label] = step;
    if (!(await tap(expression, label))) return;
    await sleep(1500);
  }
  if (screen.expectOpen && !(await evaluate(screen.expectOpen))) {
    find(screen.id, 'high', 'did-not-open', `the last step on ${screen.id} did not open what it should`);
  }

  if (keyboardUp()) {
    find(screen.id, 'high', 'keyboard-came-up', 'the keyboard came up on arrival, over the screen, without anybody tapping a field');
    await back();
  }

  await screenshot(screen.id);
  for (const issue of await evaluate(LAYOUT)) find(screen.id, issue.severity, issue.kind, issue.detail, { rect: issue.rect });

  for (const step of screen.try ?? []) {
    const before = await evaluate(VALUES);
    const tapped = await tap(step.tap, step.label);
    if (!tapped) continue;
    await sleep(1500);
    if (!(await evaluate(step.expect))) find(screen.id, 'high', 'tap-did-nothing', `tapping ${step.label} did not do what it should`);
    const changed = changedSettings(before, await evaluate(VALUES));
    if (changed.length) find(screen.id, 'high', 'tap-changed-a-setting', `tapping ${step.label} changed ${changed.join(', ')}`);
    if (keyboardUp()) {
      find(screen.id, 'medium', 'keyboard-came-up', `the keyboard came up after tapping ${step.label}`);
      await back();
    }
    await screenshot(`${screen.id}-after-${step.label.replace(/\W+/g, '-')}`);
  }

  // Back: where it goes, and that it does not close the app from anywhere
  // but the first screen.
  const before = await evaluate(WHERE);
  await back();
  if (!stillOpen()) {
    find(screen.id, screen.id === 'for-you' ? 'info' : 'high', 'back-closed-the-app', `Back from ${before} closed the app`);
    adb('shell', 'am', 'start', '-n', 'app.tvinto/.MainActivity');
    await sleep(8000);
    await reconnect();
    return;
  }
  const after = await evaluate(WHERE).catch(() => '?');
  find(screen.id, 'info', 'back', `Back: ${before} -> ${after}`);
  if (after === before) find(screen.id, 'medium', 'back-did-nothing', `Back on ${before} changed nothing`);
}

async function reconnect() {
  try { ws.close(); } catch {}
  const pid = adb('shell', 'pidof', 'app.tvinto').trim();
  execFileSync('adb', ['-s', SERIAL, 'forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  await connect();
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await connect();
  measureWebView();
  for (const screen of SCREENS) {
    if (ONLY && !ONLY.has(screen.id)) continue;
    try {
      await walk(screen);
    } catch (error) {
      find(screen.id, 'info', 'walker-error', String(error.message ?? error).slice(0, 300));
      console.log(`   walker error: ${error.message}`);
    }
    save();
  }
  await home();
  save();
  const count = s => findings.filter(f => f.severity === s).length;
  console.log(`${findings.length} findings: ${count('high')} high, ${count('medium')} medium, ${count('low')} low; ${consoleErrors.length} console errors`);
  process.exit(0);
}

main().catch(error => { console.error(error); process.exit(1); });
