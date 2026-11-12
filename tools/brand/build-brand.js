// Draws the Tvinto mark (variant E1, chosen 2 November) and writes every file
// the apps and the README need into brand/ in the repository.
//   cd tools/brand && npm install && node build-brand.js   (reads Inter from frontend/node_modules)
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const { Resvg } = require('@resvg/resvg-js');
const pngToIco = require('png-to-ico').default ?? require('png-to-ico');

const REPO = path.resolve(__dirname, '../..');
const OUT = path.join(REPO, 'brand');
const INTER_800 = path.join(REPO, 'frontend/node_modules/@fontsource/inter/files/inter-latin-800-normal.woff');

// ---- Colours: the app's own, as sRGB (resvg and launchers take no oklch) ----
function oklchToHex(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ];
  const gamma = x => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  return '#' + lin.map(x => Math.round(Math.min(1, Math.max(0, gamma(x))) * 255).toString(16).padStart(2, '0')).join('');
}
const C = {
  night: oklchToHex(0.19, 0.04, 260),
  rim: oklchToHex(0.545, 0.19, 271.5),
  arrow: oklchToHex(0.72, 0.16, 271.5),
  stem: '#ffffff'
};

// ---- The mark, in a 512 box ----
const R = 512 * 0.22;
const RIM = 18;
/** The i: a round-ended stem and a play arrow for its dot, centred on (cx, 256). */
function glyph(scale = 1, cx = 256, cy = 256) {
  const S = v => cy + (v - 256) * scale;
  const X = v => cx + (v - 256) * scale;
  const stemW = 64 * scale;
  const tri = 104 * scale;
  const w = tri * 0.87;
  const x0 = X(256) - w * 0.42;
  const top = S(92);
  return `<rect x="${X(256) - stemW / 2}" y="${S(232)}" width="${stemW}" height="${S(404) - S(232)}" rx="${stemW / 2}" fill="${C.stem}"/>` +
    `<polygon points="${x0},${top} ${x0},${top + tri} ${x0 + w},${top + tri / 2}" fill="${C.arrow}"/>`;
}
const iconSvg = (size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">` +
  `<rect width="512" height="512" rx="${R}" fill="${C.night}"/>` +
  `<rect x="${RIM / 2}" y="${RIM / 2}" width="${512 - RIM}" height="${512 - RIM}" rx="${R - RIM / 2}" fill="none" stroke="${C.rim}" stroke-width="${RIM}"/>` +
  glyph() + `</svg>`;

// ---- Android adaptive icon: 108 x 108, the visible part a 72 circle/squircle,
// the safe zone a 66 circle. The rim would be cut by a round mask, so its
// Android cut lights the edge from below instead (E4's glow), as agreed.
const adaptiveBackground =
  `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 108 108">` +
  `<defs><radialGradient id="glow" cx="0.5" cy="0.95" r="0.62"><stop offset="0" stop-color="${C.rim}" stop-opacity="0.9"/><stop offset="0.6" stop-color="${C.rim}" stop-opacity="0.25"/><stop offset="1" stop-color="${C.rim}" stop-opacity="0"/></radialGradient></defs>` +
  `<rect width="108" height="108" fill="${C.night}"/><rect width="108" height="108" fill="url(#glow)"/></svg>`;
// The i at the size it has in the 512 tile, relative to the 72 visible area.
const adaptiveForeground = `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 512 512">${glyph(72 / 108)}</svg>`;
const adaptiveMonochrome = `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432" viewBox="0 0 512 512">${glyph(72 / 108).replaceAll(C.arrow, '#ffffff')}</svg>`;

// ---- Wordmark: "tvinto" in Inter Extra Bold, outlined, the i's dot the arrow ----
const font = opentype.parse(fs.readFileSync(INTER_800).buffer.slice(0));
function wordmark({ size = 200, color = '#ffffff', arrow = C.arrow, tracking = -0.035 } = {}) {
  const parts = ['t', 'v', '\u0131', 'n', 't', 'o'];
  let x = 0;
  const baseline = size;
  let d = '';
  let dotless = null;
  for (const ch of parts) {
    const g = font.charToGlyph(ch);
    const p = g.getPath(x, baseline, size);
    d += p.toPathData(2);
    if (ch === '\u0131') {
      const bb = p.getBoundingBox();
      dotless = { x1: bb.x1, x2: bb.x2, top: bb.y1 };
    }
    x += (g.advanceWidth / font.unitsPerEm) * size + tracking * size;
  }
  const width = x - tracking * size;
  // The arrow over the stem: as tall as the stem is wide, twice over, a gap the stem's width above.
  const stem = dotless.x2 - dotless.x1;
  const tri = stem * 1.22;
  const w = tri * 0.87;
  const cx = (dotless.x1 + dotless.x2) / 2;
  const x0 = cx - w * 0.42;
  const top = dotless.top - stem * 0.3 - tri;
  const arrowPath = `M${x0.toFixed(2)} ${top.toFixed(2)}L${x0.toFixed(2)} ${(top + tri).toFixed(2)}L${(x0 + w).toFixed(2)} ${(top + tri / 2).toFixed(2)}Z`;
  const minY = Math.min(top, 0) - 2;
  const height = baseline + size * 0.02 - minY;
  return {
    width, height, minY,
    body: `<path d="${d}" fill="${color}"/><path d="${arrowPath}" fill="${arrow}"/>`
  };
}
function wordmarkSvg(opts) {
  const w = wordmark(opts);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w.width)}" height="${Math.ceil(w.height)}" viewBox="0 ${w.minY.toFixed(2)} ${w.width.toFixed(2)} ${w.height.toFixed(2)}">${w.body}</svg>`;
}

/** Icon and wordmark side by side, for the README and headers. */
function lockupSvg({ color = '#ffffff', background = null } = {}) {
  const icon = 200;
  const w = wordmark({ size: 150, color });
  const gap = 44;
  const pad = background ? 60 : 0;
  const width = pad * 2 + icon + gap + w.width;
  const height = pad * 2 + icon;
  const wordTop = pad + (icon - (150 * 0.73)) / 2 - 150 * 0.31;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${height}" viewBox="0 0 ${width.toFixed(2)} ${height}">` +
    (background ? `<rect width="100%" height="100%" fill="${background}"/>` : '') +
    `<g transform="translate(${pad} ${pad}) scale(${icon / 512})">${iconSvg().replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>` +
    `<g transform="translate(${pad + icon + gap} ${wordTop})">${w.body}</g></svg>`;
}

/** Android TV's launcher banner, 320 x 180 (xhdpi): the lockup on the night tile. */
function tvBannerSvg() {
  const width = 320, height = 180;
  const icon = 64;
  const w = wordmark({ size: 48 });
  const gap = 14;
  const total = icon + gap + w.width;
  const left = (width - total) / 2;
  const iconTop = (height - icon) / 2;
  const wordTop = iconTop + (icon - 48 * 0.73) / 2 - 48 * 0.31;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${C.night}"/>` +
    `<g transform="translate(${left} ${iconTop}) scale(${icon / 512})">${iconSvg().replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>` +
    `<g transform="translate(${left + icon + gap} ${wordTop})">${w.body}</g></svg>`;
}

// ---- Write ----
const write = (rel, data) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const png = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();

write('svg/tvinto-icon.svg', iconSvg());
write('svg/tvinto-wordmark-white.svg', wordmarkSvg({ color: '#ffffff' }));
write('svg/tvinto-wordmark-dark.svg', wordmarkSvg({ color: C.night, arrow: C.rim }));
write('svg/tvinto-lockup-dark-background.svg', lockupSvg({ color: '#ffffff', background: C.night }));
write('svg/tvinto-lockup-on-dark.svg', lockupSvg({ color: '#ffffff' }));
write('svg/tvinto-lockup-on-light.svg', lockupSvg({ color: C.night }));
write('svg/tvinto-tv-banner.svg', tvBannerSvg());
write('svg/android-adaptive-background.svg', adaptiveBackground);
write('svg/android-adaptive-foreground.svg', adaptiveForeground);
write('svg/android-adaptive-monochrome.svg', adaptiveMonochrome);

for (const size of [1024, 512, 256, 192, 180, 128, 64, 48, 32, 16]) {
  write(`png/tvinto-icon-${size}.png`, png(iconSvg(), size));
}
write('png/tvinto-tv-banner-320x180.png', png(tvBannerSvg(), 320));
write('png/tvinto-tv-banner-640x360.png', png(tvBannerSvg(), 640));
write('png/tvinto-lockup-dark-background-1200.png', png(lockupSvg({ color: '#ffffff', background: C.night }), 1200));

(async () => {
  const pngsFor = sizes => sizes.map(s => png(iconSvg(), s));
  write('ico/favicon.ico', await pngToIco(pngsFor([16, 32, 48])));
  write('ico/tvinto.ico', await pngToIco(pngsFor([16, 24, 32, 48, 64, 128, 256])));
  write('README.md', `# Tvinto's mark

Variant E1 of the logo round of 2 November 2026: the "i" of *into* with a play
arrow for its dot, white stem and indigo arrow on the app's dark navy, with an
indigo rim so the tile shows on a dark background too.

Everything here is generated from one drawing by \`tools/brand/build-brand.js\`
(\`cd tools/brand && npm install && npm run build\`); edit the drawing there, not
these files.

- \`svg/tvinto-icon.svg\` -- the app icon, 512 box. Colours: night ${C.night},
  rim ${C.rim}, arrow ${C.arrow}, stem #ffffff.
- \`svg/tvinto-wordmark-*.svg\` -- "tvinto" in Inter Extra Bold, outlined, so it
  needs no font.
- \`svg/tvinto-lockup-*.svg\` -- the icon and the wordmark side by side.
- \`svg/tvinto-tv-banner.svg\` -- Android TV's 320 x 180 launcher banner.
- \`svg/android-adaptive-*.svg\` -- Android's adaptive icon layers. A launcher
  crops the icon to its own shape, which would cut the rim unevenly, so the
  Android icon lights the tile's lower edge instead (variant E4's glow).
- \`png/\` -- the icon at 16 to 1024 px, the banner, a large lockup.
- \`ico/\` -- \`favicon.ico\` (16, 32, 48) and \`tvinto.ico\` for Windows (16 to 256).

The name and the mark are not covered by the code's licence; see the name
policy once the repository is public.
`);
  console.log('written to', OUT, C);
})();
