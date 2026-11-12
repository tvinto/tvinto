// node tools/emulator/listen.js [seconds]
//
// Prints the TV WebView's console messages and uncaught exceptions for a
// while, with any http(s) address replaced by <url> -- the provider's
// addresses carry credentials. Run it in the background, then reproduce.
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '../../frontend/node_modules/ws'));

const redact = text => String(text).replace(/https?:\/\/\S+/g, '<url>');

http.get('http://127.0.0.1:9333/json', response => {
  let body = '';
  response.on('data', chunk => (body += chunk));
  response.on('end', async () => {
    const page = JSON.parse(body).find(target => target.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise(open => ws.once('open', open));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    ws.on('message', message => {
      const event = JSON.parse(message);
      const at = new Date().toTimeString().slice(0, 8);
      if (event.method === 'Runtime.consoleAPICalled') {
        const text = event.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
        console.log(at, event.params.type, redact(text).slice(0, 300));
      } else if (event.method === 'Runtime.exceptionThrown') {
        const details = event.params.exceptionDetails;
        console.log(at, 'EXCEPTION', redact((details.exception && details.exception.description) || details.text).slice(0, 400));
      }
    });
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, Number(process.argv[2] || 60) * 1000);
  });
}).on('error', error => {
  console.error('FAILED', error.message);
  process.exit(1);
});
