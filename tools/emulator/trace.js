// node tools/emulator/trace.js [seconds] [keys]
//
// Records a timeline trace of the TV emulator's WebView for a few seconds,
// optionally pressing direction keys meanwhile (as profile.js; never OK),
// and prints where the renderer's main thread spent its time by event.
// Needs the WebView forwarded to port 9333.
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require(path.join(__dirname, '../../frontend/node_modules/ws'));

const seconds = Number(process.argv[2] || 5);
const KEYS = { up: 19, down: 20, left: 21, right: 22, back: 4 };
const presses = (process.argv[3] || '').split(',').filter(Boolean).flatMap(part => {
  const [name, times] = part.trim().split('*');
  if (!(name in KEYS)) throw new Error(`Unknown or refused key: ${name}`);
  return Array(Number(times || 1)).fill(KEYS[name]);
});
const sleep = ms => new Promise(done => setTimeout(done, ms));

http.get('http://127.0.0.1:9333/json', response => {
  let body = '';
  response.on('data', c => (body += c));
  response.on('end', async () => {
    const page = JSON.parse(body).find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1024 * 1024 * 1024 });
    await new Promise(o => ws.once('open', o));
    let id = 0;
    const events = [];
    let done;
    const finished = new Promise(resolve => (done = resolve));
    ws.on('message', m => {
      const r = JSON.parse(m);
      if (r.method === 'Tracing.dataCollected') events.push(...r.params.value);
      if (r.method === 'Tracing.tracingComplete') done();
    });
    const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
    send('Tracing.start', {
      categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink,cc,gpu,viz',
      options: 'sampling-frequency=1000'
    });
    await sleep(300);
    const end = Date.now() + seconds * 1000;
    for (const key of presses) {
      execFileSync('adb', ['shell', 'input', 'keyevent', String(key)]);
      await sleep(Math.max(200, (seconds * 1000) / (presses.length + 1)));
    }
    await sleep(Math.max(0, end - Date.now()));
    send('Tracing.end');
    await finished;

    // The renderer's main thread: the one that ran most devtools.timeline tasks.
    const tasks = events.filter(e => e.ph === 'X' && e.name === 'RunTask');
    const busiest = {};
    for (const e of tasks) busiest[`${e.pid}:${e.tid}`] = (busiest[`${e.pid}:${e.tid}`] || 0) + e.dur;
    const threads = Object.entries(busiest).sort((a, b) => b[1] - a[1]);
    const names = {};
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names[`${e.pid}:${e.tid}`] = e.args.name;
    console.log('busiest threads (ms of RunTask):');
    for (const [key, us] of threads.slice(0, 6)) console.log(`  ${(us / 1000).toFixed(0).padStart(6)}  ${names[key] || key}`);

    const main = Object.keys(names).find(key => names[key] === 'CrRendererMain') || threads[0]?.[0];
    const self = {};
    for (const e of events) {
      if (e.ph !== 'X' || `${e.pid}:${e.tid}` !== main || !e.dur) continue;
      self[e.name] = (self[e.name] || 0) + e.dur;
    }
    console.log(`renderer main (${names[main] || main}), total ms by event (nested events counted in their parents too):`);
    for (const [name, us] of Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`  ${(us / 1000).toFixed(1).padStart(8)}  ${name}`);
    }
    // How much each style and layout pass took in: elements restyled, objects laid out.
    const styled = events.filter(e => e.ph === 'X' && e.name === 'UpdateLayoutTree' && `${e.pid}:${e.tid}` === main);
    const elements = styled.map(e => e.args?.elementCount ?? 0);
    console.log(`style passes ${styled.length}, elements restyled: total ${elements.reduce((a, b) => a + b, 0)}, largest ${Math.max(0, ...elements)}`);
    // Each pass with the JavaScript that forced it, when one did.
    const callers = events.filter(e => e.ph === 'X' && e.name === 'FunctionCall' && `${e.pid}:${e.tid}` === main);
    const forcedBy = e => {
      const outer = callers.find(c => c.ts <= e.ts && c.ts + c.dur >= e.ts + e.dur);
      const data = outer?.args?.data;
      return data ? `${data.functionName || '?'} ${String(data.url || '').split('/').pop()}:${data.lineNumber}` : 'frame';
    };
    console.log('passes: ' + styled.map(e => `${e.args?.elementCount ?? 0}@${forcedBy(e)}`).slice(0, 40).join(' | '));
    const layouts = events.filter(e => e.name === 'Layout' && `${e.pid}:${e.tid}` === main && e.args?.beginData);
    const dirty = layouts.map(e => `${e.args.beginData.dirtyObjects}/${e.args.beginData.totalObjects}`);
    console.log(`layouts ${layouts.length}, dirty/total objects: ${dirty.slice(0, 12).join(', ')}`);
    const posted = {};
    for (const e of tasks) {
      if (`${e.pid}:${e.tid}` !== main) continue;
      const loc = e.args?.src_func
        ? `${e.args.src_func} (${String(e.args.src_file || '').split('/').pop()})`
        : JSON.stringify(e.args || {}).slice(0, 80);
      posted[loc] = (posted[loc] || 0) + e.dur;
    }
    console.log('renderer main RunTask by where it was posted:');
    for (const [loc, us] of Object.entries(posted).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${(us / 1000).toFixed(1).padStart(8)}  ${loc}`);
    }
    ws.close();
  });
});
