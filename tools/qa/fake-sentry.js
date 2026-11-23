#!/usr/bin/env node
/**
 * A stand-in for Sentry on this machine, for testing error reports
 * (docs/error-reports.md) without a Sentry account or anybody's DSN.
 *
 * Accepts what the SDKs send -- envelopes on /api/<project>/envelope/, and
 * the older /api/<project>/store/ -- gzipped or not, and saves each item as
 * it arrived under --out (a JSON file per event, the bytes of a minidump or
 * other attachment beside it). It prints only what kind of item arrived,
 * never its contents.
 *
 *   node tools/qa/fake-sentry.js [--port 8790] [--out <folder>]
 *
 * The app's DSN for it, in frontend/config.local.json (not committed):
 *
 *   "errorReportsDsn": "http://fakekey@127.0.0.1:8790/1"
 *
 * GET /qa/received lists what arrived: per event its type, message, release,
 * whether it named a user or an IP address, and Sentry's infer_ip setting --
 * which is how a test shows no IP address is sent (none in the event, and
 * "never" for Sentry to work one out from the connection). GET /qa/clear
 * forgets them.
 */

const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const PORT = Number(arg('--port', 8790));
const OUT = path.resolve(arg('--out', path.join(require('os').tmpdir(), 'tvinto-fake-sentry')));
fs.mkdirSync(OUT, { recursive: true });

/** What arrived, in order, as summaries. */
let received = [];
let count = 0;

/** An envelope: a header line, then for each item a header line and its payload (by length, or to the next newline). */
function parseEnvelope(buffer) {
  const items = [];
  let at = buffer.indexOf(10);
  const header = JSON.parse(buffer.subarray(0, at < 0 ? buffer.length : at).toString('utf8'));
  at = at < 0 ? buffer.length : at + 1;
  while (at < buffer.length) {
    let end = buffer.indexOf(10, at);
    if (end < 0) end = buffer.length;
    const line = buffer.subarray(at, end).toString('utf8').trim();
    at = end + 1;
    if (!line) continue;
    const itemHeader = JSON.parse(line);
    let payload;
    if (typeof itemHeader.length === 'number') {
      payload = buffer.subarray(at, at + itemHeader.length);
      at += itemHeader.length + 1;
    } else {
      let next = buffer.indexOf(10, at);
      if (next < 0) next = buffer.length;
      payload = buffer.subarray(at, next);
      at = next + 1;
    }
    items.push({ header: itemHeader, payload });
  }
  return { header, items };
}

function summarise(event) {
  const exception = event.exception?.values?.[0];
  return {
    type: event.type || 'event',
    message: exception ? `${exception.type}: ${exception.value}` : event.message?.formatted ?? event.message ?? null,
    release: event.release ?? null,
    environment: event.environment ?? null,
    tags: event.tags ?? {},
    user: event.user ?? null,
    ipAddress: event.user?.ip_address ?? null,
    inferIp: event.sdk?.settings?.infer_ip ?? null,
    logLines: Array.isArray(event.extra?.log) ? event.extra.log.length : 0
  };
}

function save(body) {
  const { items } = parseEnvelope(body);
  const stamp = `${Date.now()}-${++count}`;
  for (const [index, item] of items.entries()) {
    const kind = item.header.type;
    if (kind === 'event' || kind === 'transaction') {
      const event = JSON.parse(item.payload.toString('utf8'));
      fs.writeFileSync(path.join(OUT, `${stamp}-${index}-${kind}.json`), JSON.stringify(event, null, 2));
      received.push({ file: `${stamp}-${index}-${kind}.json`, ...summarise(event) });
      console.info(`[fake-sentry] ${kind}`);
    } else if (kind === 'attachment') {
      const name = `${stamp}-${index}-${String(item.header.filename || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_')}`;
      fs.writeFileSync(path.join(OUT, name), item.payload);
      received.push({ file: name, type: 'attachment', attachmentType: item.header.attachment_type ?? null, bytes: item.payload.length });
      console.info(`[fake-sentry] attachment, ${item.payload.length} bytes`);
    } else {
      // Sessions, client reports: nothing the app should send. Counted, so a test sees them.
      received.push({ type: kind, unexpected: true });
      console.info(`[fake-sentry] ${kind} (not expected)`);
    }
  }
}

http
  .createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/qa/received') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ out: OUT, received }, null, 2));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/qa/clear') {
      received = [];
      response.end('cleared\n');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(200, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' });
      response.end();
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      let body = Buffer.concat(chunks);
      try {
        if (/gzip/i.test(request.headers['content-encoding'] || '')) {
          body = zlib.gunzipSync(body);
        }
        if (/\/api\/\d+\/envelope\/?$/.test(url.pathname)) {
          save(body);
        } else if (/\/api\/\d+\/store\/?$/.test(url.pathname)) {
          const event = JSON.parse(body.toString('utf8'));
          fs.writeFileSync(path.join(OUT, `${Date.now()}-${++count}-store.json`), JSON.stringify(event, null, 2));
          received.push(summarise(event));
        } else {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        response.end('{"id":"0"}');
      } catch (error) {
        console.info(`[fake-sentry] could not read a request: ${error.message}`);
        response.writeHead(400);
        response.end();
      }
    });
  })
  .listen(PORT, '127.0.0.1', () => console.info(`[fake-sentry] on http://127.0.0.1:${PORT}, saving to ${OUT}`));
