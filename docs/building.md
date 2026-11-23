# Building and testing Tvinto

## What you need

- **Node.js 24** (the version CI uses).
- **For Android:** the Android SDK from Android Studio (compile SDK 36,
  minimum Android 7.0, which is API 24) and JDK 21. An Android TV emulator for
  anything that runs on a TV.
- **For Windows:** nothing extra. `npm run electron:make` downloads mpv and
  libmpv the first time, at a fixed version, and checks their hashes
  (`npm run fetch:mpv`). It also builds `tvinto-player.exe`, the player that
  draws into the app's window, with Zig, which it downloads into
  `%LOCALAPPDATA%\tvinto-build` the same way (`npm run build:player`). Where
  mpv comes from is under [mpv](#mpv) below.

## First time

```bash
npm install                                  # the root folder (shared/ uses fast-xml-parser from it)
cd backend  && npm install && cd ..          # runs the tests for shared/, worker/ and cli/
cd frontend && npm install && cd ..
cd frontend/electron && npm install && cd ../..
```

### Pointing your own builds at a sync service

The code doesn't name any sync service. A build without one works without an
account and asks for a server address at sign-in. If you want your own builds
to know your service, copy `frontend/config.example.json` to
`frontend/config.local.json` (git ignores it) and fill it in:

```json
{
  "apiUrl": "https://tvinto-sync.yourname.workers.dev/api"
}
```

`npm run build` writes `frontend/src/config.js` from it before building.
Builds update themselves from the project's releases on GitHub. To use a
different feed, for example your fork's, add `updatesUrl` to the same file.

## Tests

```bash
cd backend  && npx jest       # shared/, worker/ and cli/, about 1,500 tests
cd frontend && npx jest       # the app: plain TypeScript tests and Angular TestBeds
npx eslint . --max-warnings 0 # in backend/ and frontend/. CI fails on any warning
```

The Android native player has JUnit tests: run `./gradlew testDebugUnitTest`
in `frontend/android`.

## Building each platform

```bash
cd frontend && npm run build                  # the web app, into dist/

# Android: copy the web app into the Android project, then build an APK
npx cap sync android
cd android && ./gradlew assembleDebug

# Windows: copy the web app into Electron, then build an installer
npx cap copy electron
cd electron && npm run electron:make
```

The sync service, from `worker/`:

```bash
cp wrangler.example.toml wrangler.toml        # your own copy, ignored by git
npx wrangler dev --local                      # runs it on your machine
npx wrangler deploy                           # deploys it to your Cloudflare account
```

The `tvinto` command line, from `cli/`. People get it from npm (`npx tvinto`)
or inside the desktop app; building it is only for working on it:

```bash
cd cli && npm install && npm run build        # into cli/dist/tvinto.js
node dist/tvinto.js --help
../backend/node_modules/.bin/tsc -p .         # its types; esbuild checks none
npm run publish:cli                           # build, test, npm publish --dry-run
```

`electron:make` builds it too (`npm run build:cli`) and packages it into the
installer's `resources/cli`, where the app runs it with its own executable.

### mpv

The desktop app plays video with mpv: `mpv.exe`, and `libmpv-2.dll` for
`tvinto-player.exe`. `npm run fetch:mpv` takes them from shinchiro's Windows
builds (github.com/shinchiro/mpv-winbuild-cmake), the ones mpv.io points to.
shinchiro keeps only about thirty days of builds, so the script downloads a
copy from this repository's release `deps-mpv-<build>` and falls back to
shinchiro's only when that copy is missing, saying so.

The release holds the two archives exactly as shinchiro published them, under
the same names. `scripts/fetch-mpv.js` checks each one's SHA-256, and the file
it takes out of each, before using it:

| Release `deps-mpv-20261111` | SHA-256 |
|---|---|
| `mpv-x86_64-20261111-git-bcde6b93cc.7z` (34.2 MB, gives `mpv.exe`) | `f259b5fd4b5c395617c948a4fadcdf55bba1c5282fb7c13e88626b3f71072baf` |
| `mpv-dev-x86_64-20261111-git-bcde6b93cc.7z` (31.8 MB, gives `libmpv-2.dll`) | `273c079b11ea5575822f972756f4c9a71149a5c10130353abeb8586738938452` |

They are built from mpv commit
[`bcde6b93cc`](https://github.com/mpv-player/mpv/tree/bcde6b93cca4d128d84e1a60d1a6db2cd81c889e)
(38 commits after
[v0.42.0](https://github.com/mpv-player/mpv/tree/v0.42.0)), with the FFmpeg
and other libraries shinchiro's build scripts name. mpv is GPL (version 2 or
later; some of the libraries in these builds may raise it to version 3), so anyone given the installer is entitled
to their source: the mpv commit above and shinchiro's scripts at that build.

To move to a newer build: change `RELEASE` and the four hashes in
`scripts/fetch-mpv.js`, download both archives from shinchiro's release of that
date, check their hashes, and attach them unchanged to a new release
`deps-mpv-<date>` here, then update the table above.

After changing `worker/`, rebuild the copy used by the Deploy button with
`node worker/scripts/build-server.mjs`. CI checks that it's up to date. If you
change the database schema, also add the next numbered file in
`server/migrations/`.

## Worth knowing before you start

Each of these has cost someone hours.

- **Use `npx cap copy electron`, never `cap sync electron`.** Sync rebuilds
  the Electron plugin list and adds back a SQLite plugin whose desktop part
  needs a native module rebuilt for Electron. After that the app won't start.
  Android is the opposite: it needs `cap sync`, or plugins are silently
  missing when the app runs.
- **The app is zoneless.** A view only redraws when a signal it reads changes
  or an event reaches its template. A timer, a promise or a plugin callback
  won't redraw it. So anything a template shows has to be in a signal. The
  Jest TestBeds still load zone.js, which means passing tests don't prove a
  screen updates. Look at the screen.
- **A file in `shared/` that nothing imports isn't type-checked.** Import it
  from real code or from a test.
- **The desktop app's main process carries a copy of `shared/errorReports.ts`**
  in `frontend/electron/src/shared/`, because its build can't reach
  `shared/`. After changing the original, run
  `node frontend/electron/scripts/copy-shared.js`. A test fails until you do.
- **An Android device keeps the web bundle it downloaded.** Installing a new
  debug APK doesn't replace the web app the device already fetched from the
  update feed, unless `versionName` or `versionCode` changed. To test a
  build, set `versionName` higher than the published one, for the test only.
- **On Android, all Capacitor plugin calls share one thread.** A slow plugin
  method holds up every other plugin. Give slow methods their own thread (see
  `storage/DatabaseLanePlugin.java`).
- **While the native player is on screen, the web app behind it slows to a
  crawl.** The player must never wait on the web app while playing. Give it
  everything it needs before it opens.
- **Don't open and save source files with Windows PowerShell's
  `Get-Content`/`Set-Content`.** They mangle UTF-8 (a lot of the app's text is
  Croatian), and `-Encoding utf8` adds a byte order mark.
  `backend/src/utils/sourceEncoding.test.ts` catches both.
- **Test against the fake provider, not a real one.**
  `node tools/qa/fake-xtream.js` answers like an Xtream panel with made up
  channels, films and guides (user and password are both `walk`) and refuses
  every stream. Add `--demo` for a believable line-up to take screenshots of.
  Real providers usually allow one connection and may block a client that
  hammers them. With `--live-hls <folder of ffmpeg HLS segments>` its live
  channels play, and `/qa/fault` makes the playlist fail, hang, repeat or
  skip, so you can test what the player does when a provider has a hiccup.
  `/qa/count` says how many stream requests were made and the most open at
  once, and `/qa/requests` lists each one -- films and episodes too -- with
  its range, its bytes, when its connection opened and closed, and any other
  request open at the same moment. `--play <film>` serves a local film for
  every stream address, and `--play-kbps <n>` sends it no faster than a real
  line would, so a player's cache fills slowly and a switch happens mid-transfer.
- **A TV change isn't finished until you've walked it.**
  `tools/qa/tv-walk.js` presses every direction from every focusable element
  on each screen of the TV emulator and reports where focus gets lost.
  `tools/qa/phone-walk.js` does the same on a phone.
