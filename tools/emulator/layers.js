// node tools/emulator/layers.js -- counts the compositor layers of the TV
// emulator's WebView page, and says what made the biggest groups of them.
// Needs the WebView forwarded to port 9333.
const http = require('http');
const path = require('path');
const WebSocket = require(path.join(__dirname, '../../frontend/node_modules/ws'));

http.get('http://127.0.0.1:9333/json', response => {
  let body = '';
  response.on('data', c => (body += c));
  response.on('end', async () => {
    const page = JSON.parse(body).find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 512 * 1024 * 1024 });
    await new Promise(o => ws.once('open', o));
    let id = 0;
    const pending = new Map();
    let layers = null;
    ws.on('message', m => {
      const r = JSON.parse(m);
      if (r.method === 'LayerTree.layerTreeDidChange' && r.params.layers) layers = r.params.layers;
      if (r.id && pending.has(r.id)) { pending.get(r.id)(r.result); pending.delete(r.id); }
    });
    const call = (method, params = {}) => new Promise(resolve => { const mine = ++id; pending.set(mine, resolve); ws.send(JSON.stringify({ id: mine, method, params })); });
    await call('DOM.enable');
    await call('LayerTree.enable');
    // Nudge a frame so the tree is reported.
    await call('Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true });
    for (let i = 0; i < 20 && !layers; i++) await new Promise(r => setTimeout(r, 200));
    if (!layers) { console.log('no layer tree reported'); ws.close(); return; }
    const withNode = layers.filter(l => l.backendNodeId);
    console.log(`layers ${layers.length}, of them with a DOM node ${withNode.length}`);
    const reasons = {};
    for (const layer of withNode.slice(0, 400)) {
      const r = await call('LayerTree.compositingReasons', { layerId: layer.layerId });
      const key = (r?.compositingReasonIds || r?.compositingReasons || ['?']).join('+');
      reasons[key] = (reasons[key] || 0) + 1;
      // What started it: every layer that is not there for overlapping another.
      if (!/overlap/i.test(key)) {
        const d = await call('DOM.resolveNode', { backendNodeId: layer.backendNodeId });
        const objectId = d?.object?.objectId;
        const desc = objectId
          ? await call('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return this.tagName + "." + String(this.className || "").split(" ").join(".") + " style=" + (this.getAttribute && this.getAttribute("style") || ""); }', returnByValue: true })
          : null;
        console.log(`  own layer (${key}): ${String(desc?.result?.value || '?').slice(0, 220)}`);
      }
    }
    for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${String(count).padStart(5)}  ${reason}`);
    }
    // Which elements, by class, for the biggest group.
    const sample = {};
    for (const layer of withNode.slice(0, 400)) {
      const d = await call('DOM.resolveNode', { backendNodeId: layer.backendNodeId });
      const objectId = d?.object?.objectId;
      if (!objectId) continue;
      const desc = await call('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return this.tagName + "." + String(this.className || "").split(" ").slice(0, 6).join("."); }', returnByValue: true });
      const key = desc?.result?.value || '?';
      sample[key] = (sample[key] || 0) + 1;
    }
    console.log('elements with layers, by tag and first classes:');
    for (const [key, count] of Object.entries(sample).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${String(count).padStart(5)}  ${key.slice(0, 150)}`);
    }
    ws.close();
  });
});
