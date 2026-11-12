import { fromAppPage } from './appPage';
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import http from 'http';

/**
 * The desktop app's own address for tvinto, when there is no sync service:
 * http://127.0.0.1:47390/api.
 *
 * Only this machine can reach it, and only what is not a web page: a request
 * that names an Origin (a browser's, from any page) or another Host (a name
 * rebound to this address) is refused before the page hears of it. The page
 * answers everything else (LocalToolService) -- this only carries requests
 * there and answers back, and the page answers only while it is used
 * without an account.
 */

export const LOCAL_API_PORT = 47390;

const ALLOWED_HOSTS = new Set([`127.0.0.1:${LOCAL_API_PORT}`, `localhost:${LOCAL_API_PORT}`]);
const MAX_BODY = 1024 * 1024;
const ANSWER_WITHIN_MS = 30_000;

let nextId = 1;
const waiting = new Map<number, (response: { status: number; body: unknown }) => void>();

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function startLocalApi(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('xtream:local-api-reply', (event, id: number, response: { status: number; body: unknown }) => {
    if (!fromAppPage(event)) {
      return;
    }
    waiting.get(id)?.(response);
    waiting.delete(id);
  });

  const server = http.createServer((req, res) => {
    if (!ALLOWED_HOSTS.has(req.headers.host ?? '') || req.headers.origin !== undefined) {
      send(res, 403, { success: false, message: 'Not from here' });
      return;
    }
    let body = '';
    let tooBig = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) {
        return;
      }
      const window = getWindow();
      if (!window || window.isDestroyed()) {
        send(res, 503, { success: false, message: 'The app is starting' });
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        send(res, 504, { success: false, message: 'The app did not answer' });
      }, ANSWER_WITHIN_MS);
      waiting.set(id, response => {
        clearTimeout(timer);
        send(res, response.status, response.body);
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
          headers[name.toLowerCase()] = value;
        }
      }
      window.webContents.send('xtream:local-api', id, { method: req.method ?? 'GET', path: req.url ?? '/', headers, body: body || null });
    });
  });

  // Taken by another copy or another program: tvinto without an account is
  // simply not offered here, and nothing else depends on it.
  server.on('error', error => console.warn('[local api] not listening:', error.message));
  server.listen(LOCAL_API_PORT, '127.0.0.1');
}
