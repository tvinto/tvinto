// node tools/emulator/tv.js "<expression>"
//
// Evaluates an expression in the TV emulator's WebView and prints the result
// as JSON. Needs the WebView forwarded to port 9333 first (tvbuild.sh does it):
//   adb forward tcp:9333 localabstract:webview_devtools_remote_$(adb shell pidof app.tvinto)
//
// The expression may return a promise. Never print provider addresses or
// credentials from here: read them inside the page and print only what they
// led to (see CLAUDE.md).
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '../../frontend/node_modules/ws'));

http.get('http://127.0.0.1:9333/json', response => {
  let body = '';
  response.on('data', chunk => (body += chunk));
  response.on('end', async () => {
    const page = JSON.parse(body).find(target => target.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise(open => ws.once('open', open));
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: process.argv[2], awaitPromise: true, returnByValue: true }
    }));
    ws.on('message', message => {
      const reply = JSON.parse(message);
      if (reply.id === 1) {
        console.log(JSON.stringify(reply.result.exceptionDetails ?? reply.result.result.value));
        ws.close();
      }
    });
  });
}).on('error', error => {
  console.error('FAILED', error.message);
  process.exit(1);
});
