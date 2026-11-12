// Builds src/assets/phone-form.html: the page a phone opens from the QR code
// on the TV (phone-page/page.ts, phone-form.utils.ts). One file, script and
// style inline, because the TV serves it from memory and the phone fetches
// nothing else. The TV fills in `__TVINTO_FORM__` -- the form's fields and
// words -- as it serves it. Generated, like src/config.js, and not committed.
import { buildSync } from 'esbuild';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const script = buildSync({
  entryPoints: [join(root, 'phone-page', 'page.ts')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2019',
  write: false,
  legalComments: 'none'
}).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const style = `
:root { color-scheme: dark; --bg: #0b1220; --panel: #121b2e; --line: #26324a; --ink: #eef2fb; --soft: #9aa6bf; --accent: #e9edf7; --ok: #5fd39a; --bad: #ff8f8f; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--ink); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 32px max(16px, env(safe-area-inset-right)) 32px max(16px, env(safe-area-inset-left)); }
main { max-width: 420px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.brand { font-weight: 700; letter-spacing: 0.02em; color: var(--soft); font-size: 14px; }
h1 { margin: 0; font-size: 24px; line-height: 1.2; text-wrap: balance; }
form { display: flex; flex-direction: column; gap: 16px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--soft); }
input { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; width: 100%; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { font: inherit; font-weight: 600; border: 0; border-radius: 999px; padding: 14px 20px; background: var(--accent); color: #0b1220; }
button:disabled { opacity: 0.6; }
.status { margin: 0; font-size: 15px; }
.status.done { color: var(--ok); font-weight: 600; font-size: 18px; }
.status.error { color: var(--bad); }
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'">
<title>Tvinto</title>
<style>${style}</style>
</head>
<body>
<main>
<div class="brand">Tvinto</div>
<h1 id="title"></h1>
<div id="form"></div>
<p id="status" class="status" role="status"></p>
</main>
<script>window.TVINTO_FORM = __TVINTO_FORM__;</script>
<script>${script}</script>
</body>
</html>
`;

writeFileSync(join(root, 'src', 'assets', 'phone-form.html'), html);
console.info(`phone-form.html: ${Math.round(html.length / 1024)} KB`);
