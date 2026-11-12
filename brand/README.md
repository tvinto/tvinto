# The Tvinto logo

The logo is the "i" from *into*, with a play arrow as its dot. The stem is
white and the arrow indigo, on the app's dark navy, with an indigo rim so the
tile still stands out on a dark background. (It's variant E1 from the logo
round of 2 November 2026.)

Every file here is generated from one drawing by
`tools/brand/build-brand.js` (`cd tools/brand && npm install && npm run build`).
Change the drawing there, not these files.

- `svg/tvinto-icon.svg`: the app icon, on a 512 px grid. Colours: night
  #091426, rim #4c60dd, arrow #819cff, stem #ffffff.
- `svg/tvinto-wordmark-*.svg`: the word "tvinto" in Inter Extra Bold,
  converted to outlines so it doesn't need the font.
- `svg/tvinto-lockup-*.svg`: the icon and the word side by side.
- `svg/tvinto-tv-banner.svg`: the 320 × 180 banner for the Android TV
  launcher.
- `svg/android-adaptive-*.svg`: the layers of Android's adaptive icon.
  Launchers crop icons into their own shapes, which would cut the rim
  unevenly, so the Android icon has a glow along the bottom edge instead
  (borrowed from variant E4).
- `png/`: the icon from 16 to 1024 px, the banner, and a large lockup.
- `ico/`: `favicon.ico` (16, 32, 48) and `tvinto.ico` for Windows (16 to 256).

The name and logo aren't covered by the code's licence. See
[NAME-POLICY.md](../NAME-POLICY.md).
