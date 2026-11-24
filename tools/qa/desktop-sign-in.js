#!/usr/bin/env node
/**
 * Signs in on a development desktop copy and checks that the requests after
 * sign-in are let in: none answered 401, and the account's providers and
 * settings answered 200. Sign-in alone answering 200 proves nothing -- on
 * 24 November it did, and every request after it was refused.
 *
 * For a throwaway copy only (XTREAM_HEADLESS=1, its own XTREAM_DEV_DATA,
 * started with --remote-debugging-port), signed out. Against a local sync
 * service with a test account, never anybody's real one.
 *
 *   node tools/qa/desktop-sign-in.js --cdp 9333 --server http://127.0.0.1:8815/api
 *     --user <name> --password <password> [--register] [--fresh] [--kept] [--through-redirect]
 *
 * Without --fresh the device keeps what it has -- a library used without an
 * account, whose providers then move to the account (the owner's case).
 * --fresh clears the page's localStorage first, as a new device.
 * --through-redirect types http://[::1]:<port>/api instead, and answers it here
 *   with a 307 to the real server: another origin, as an http:// address on an
 *   HSTS host is to its https:// one. Chromium drops Authorization across that.
 * --kept puts the address in storage as an older version kept it, instead of
 *   typing it on the sign-in card.
 *
 * Prints only paths and statuses; never the token or the password.
 */

const http = require('http');

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const flag = name => process.argv.includes(name);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const cdpPort = arg('--cdp', '9333');
const server = arg('--server', 'http://127.0.0.1:8815/api');
const user = arg('--user', '');
const password = arg('--password', '');
if (!user || !password) {
  console.error('--user and --password are required');
  process.exit(2);
}

async function redirector() {
  const target = new URL(server);
  const proxy = http.createServer((req, res) => res.writeHead(307, { Location: target.origin + req.url }).end());
  await new Promise((resolve, reject) => proxy.once('error', reject).listen(Number(target.port || 80), '::1', resolve));
  return { typed: `http://[::1]:${target.port || 80}${target.pathname}`, proxy };
}

async function page() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  const found = targets.find(t => t.type === 'page' && !t.url.startsWith('devtools'));
  const ws = new WebSocket(found.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve));
  let id = 0;
  const pending = new Map();
  const answers = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    } else if (message.method === 'Network.responseReceived' && /\/api\//.test(message.params.response.url)) {
      answers.push({ path: new URL(message.params.response.url).pathname, status: message.params.response.status });
    }
  });
  const send = (method, params = {}) =>
    new Promise(resolve => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async expression =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  return { ws, send, run, answers };
}

(async () => {
  const through = flag('--through-redirect') ? await redirector() : null;
  const typed = through ? through.typed : server;
  const app = await page();
  await app.run(`${flag('--fresh') ? 'localStorage.clear();' : ''} localStorage.removeItem('xtream_server_url'); ${flag('--kept') ? `localStorage.setItem('xtream_server_url', ${JSON.stringify(typed)});` : ''} location.href = 'capacitor-electron://-/sign-in'; 1`);
  await wait(3000);
  await app.send('Network.enable');

  const outcome = await app.run(`(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const fill = (selector, value) => {
      const input = document.querySelector(selector);
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    if (${flag('--register')}) [...document.querySelectorAll('button')].find(b => /create account/i.test(b.textContent))?.click();
    await wait(300);
    if (!${flag('--kept')} && !fill('#server', ${JSON.stringify(typed)})) return 'no server field on the sign-in card';
    fill('#username', ${JSON.stringify(user)});
    fill('#password', ${JSON.stringify(password)});
    await wait(100);
    document.querySelector('form button[type=submit]').click();
    for (let i = 0; i < 40 && /sign-in/.test(location.href); i++) await wait(250);
    await wait(5000);
    return location.pathname;
  })()`);

  const kept = await app.run(`localStorage.getItem('xtream_server_url')`);
  app.ws.close();
  through?.proxy.close();

  const refused = app.answers.filter(a => a.status === 401);
  const ok = path => app.answers.some(a => a.path.endsWith(path) && a.status === 200);
  const failures = [
    ...(/\/(welcome|sign-in)$/.test(outcome) ? [`still at ${outcome}`] : []),
    ...refused.map(a => `401 ${a.path}`),
    ...(ok('/accounts/providers') ? [] : ['/accounts/providers never answered 200']),
    ...(ok('/devices/settings') ? [] : ['/devices/settings never answered 200'])
  ];
  console.info(`at ${outcome}; server kept as ${kept === server ? 'the real address' : kept === typed ? 'the typed address' : 'something else'}`);
  console.info(app.answers.map(a => `${a.status} ${a.path}`).join('\n'));
  if (failures.length) {
    console.error(`FAIL\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.info('PASS: signed in, and the requests after it were let in');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
