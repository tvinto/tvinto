// node tools/emulator/holdok.js [holdMs]
//
// Holds OK (Enter) in the TV WebView the way a real remote does: a press,
// then repeats every 50 ms from 400 ms -- not marked as repeats, as Android
// TV's WebView sends them -- and the release at holdMs (default 1200).
//
// `adb shell input keyevent --longpress` sends a single repeat and nothing
// more, `adb emu event send` never reached the page, and writing to
// /dev/input is refused by SELinux; this is what reproduced the hold-OK bug
// of 28 September. Verify focus before running it: OK acts on whatever has it.
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '../../frontend/node_modules/ws'));

const holdMs = Number(process.argv[2] || 1200);

http.get('http://127.0.0.1:9333/json', response => {
  let body = '';
  response.on('data', chunk => (body += chunk));
  response.on('end', async () => {
    const page = JSON.parse(body).find(target => target.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(open => ws.once('open', open));
    let id = 0;
    const send = (method, params) =>
      new Promise(done => {
        const mine = ++id;
        const onMessage = message => {
          const reply = JSON.parse(message);
          if (reply.id === mine) {
            ws.off('message', onMessage);
            done(reply);
          }
        };
        ws.on('message', onMessage);
        ws.send(JSON.stringify({ id: mine, method, params }));
      });
    const key = type =>
      send('Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: type === 'keyDown' ? '\r' : undefined
      });

    const started = Date.now();
    await key('keyDown');
    await new Promise(wait => setTimeout(wait, 400));
    while (Date.now() - started < holdMs) {
      await key('keyDown');
      await new Promise(wait => setTimeout(wait, 50));
    }
    await key('keyUp');
    console.log('held', Date.now() - started, 'ms');
    ws.close();
  });
}).on('error', error => {
  console.error('FAILED', error.message);
  process.exit(1);
});
