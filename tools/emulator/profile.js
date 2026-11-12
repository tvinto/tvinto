// node tools/emulator/profile.js <keys> [--throttle N] [--gap MS] [--out FILE]
//
// Presses keys on the TV emulator and measures what each costs the WebView:
// the time from a key press to the frame that shows its result, the page's
// own totals (script, layout, style), and where the JavaScript time went.
// Needs the WebView forwarded to port 9333 (tvbuild.sh does it).
//
// <keys> is a list like "down*10,right*3,back": up down left right back.
// OK is refused -- a script never presses OK on a target it has not checked
// (CLAUDE.md), and a profile has no business starting playback.
//
// --throttle slows the emulator's CPU by that factor (Emulation), nearer to
// a television's than a PC's. --out keeps the raw CPU profile, which Chrome's
// DevTools can open.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '../../frontend/node_modules/ws'));

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const KEYS = { up: 19, down: 20, left: 21, right: 22, back: 4 };
const presses = (args[0] || '')
  .split(',')
  .filter(Boolean)
  .flatMap(part => {
    const [name, times] = part.trim().split('*');
    if (!(name in KEYS)) {
      throw new Error(`Unknown or refused key: ${name}`);
    }
    return Array(Number(times || 1)).fill(KEYS[name]);
  });
const throttle = Number(option('--throttle', '1'));
const gap = Number(option('--gap', '700'));
const out = option('--out', null);

const sleep = ms => new Promise(done => setTimeout(done, ms));

http.get('http://127.0.0.1:9333/json', response => {
  let body = '';
  response.on('data', chunk => (body += chunk));
  response.on('end', async () => {
    const page = JSON.parse(body).find(target => target.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
    await new Promise(open => ws.once('open', open));
    let id = 0;
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mine = ++id;
        const on = message => {
          const reply = JSON.parse(message);
          if (reply.id === mine) {
            ws.off('message', on);
            reply.error ? reject(new Error(`${method}: ${reply.error.message}`)) : resolve(reply.result);
          }
        };
        ws.on('message', on);
        ws.send(JSON.stringify({ id: mine, method, params }));
      });
    const evaluate = async expression =>
      (await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
    const metrics = async () =>
      Object.fromEntries((await call('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));

    // Key press to the second frame after it: the first frame may be one
    // already on its way; the second is the one that can show the press.
    await evaluate(`(() => {
      window.__lat = [];
      if (!window.__latHooked) {
        window.__latHooked = true;
        window.addEventListener('keydown', () => {
          const t0 = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - t0)));
        }, true);
      }
      return true;
    })()`);

    await call('Performance.enable');
    await call('Emulation.setCPUThrottlingRate', { rate: throttle });
    await call('Profiler.enable');
    await call('Profiler.setSamplingInterval', { interval: 250 });
    const before = await metrics();
    await call('Profiler.start');

    for (const key of presses) {
      execFileSync('adb', ['shell', 'input', 'keyevent', String(key)]);
      await sleep(gap);
    }
    // --idle S: a quiet stretch with no input, for what runs on its own.
    await sleep(1000 + Number(option('--idle', '0')) * 1000);

    const { profile } = await call('Profiler.stop');
    const after = await metrics();
    await call('Emulation.setCPUThrottlingRate', { rate: 1 });
    const latencies = await evaluate('window.__lat');

    if (out) {
      fs.writeFileSync(out, JSON.stringify(profile));
    }

    // Self time per function, from the samples.
    const byId = new Map(profile.nodes.map(node => [node.id, node]));
    const self = new Map();
    const deltas = profile.timeDeltas;
    profile.samples.forEach((nodeId, index) => {
      const node = byId.get(nodeId);
      const frame = node.callFrame;
      const name = `${frame.functionName || '(anonymous)'} ${path.basename(frame.url || '')}:${frame.lineNumber + 1}`;
      self.set(name, (self.get(name) || 0) + (deltas[index] || 0) / 1000);
    });
    const total = [...self.values()].reduce((sum, ms) => sum + ms, 0);
    const share = prefix => Math.round([...self.entries()].filter(([name]) => name.startsWith(prefix)).reduce((sum, [, ms]) => sum + ms, 0));
    console.log(`(idle) ${share('(idle)')} ms, (program) ${share('(program)')} ms, (garbage collector) ${share('(garbage collector)')} ms`);
    const top = [...self.entries()]
      .filter(([name]) => !name.startsWith('(idle)') && !name.startsWith('(program)'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25);

    const sorted = [...latencies].sort((a, b) => a - b);
    const pick = share => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]) : null);
    const delta = name => Math.round(((after[name] || 0) - (before[name] || 0)) * 1000);

    console.log(`presses ${presses.length}, throttle ${throttle}x`);
    console.log(`press to frame (ms): median ${pick(0.5)}, p90 ${pick(0.9)}, max ${sorted.length ? Math.round(sorted[sorted.length - 1]) : null}`);
    console.log(`page totals (ms): task ${delta('TaskDuration')}, script ${delta('ScriptDuration')}, layout ${delta('LayoutDuration')}, style ${delta('RecalcStyleDuration')}; layouts ${Math.round(after.LayoutCount - before.LayoutCount)}, style recalcs ${Math.round(after.RecalcStyleCount - before.RecalcStyleCount)}`);
    console.log(`DOM nodes ${after.Nodes}, JS heap ${Math.round(after.JSHeapUsedSize / 1e6)} MB`);
    console.log(`sampled ${Math.round(total)} ms; top self time:`);
    for (const [name, ms] of top) {
      console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${name}`);
    }
    ws.close();
  });
}).on('error', error => {
  console.error('FAILED', error.message);
  process.exit(1);
});
