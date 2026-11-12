# How Tvinto is put together

There is one app, built for three platforms. It talks to your IPTV provider
directly, and to a sync service only if you want your devices to share
things.

```
                 ┌─────────────── your devices ───────────────┐
 IPTV provider ◀─┤  Android TV · Android phone · Windows       │
 (Xtream / M3U)  │  frontend/ : Angular, Capacitor, Electron   │
                 └──────────────────────┬──────────────────────┘
                                        │ optional: sync
                                        ▼
                         sync service: worker/ (Cloudflare Worker + D1)
                                        ▲
                         tvinto CLI / MCP server: cli/
```

## The app (`frontend/`)

An Angular app, zoneless and built on signals.

- **Android** (phone and TV) wraps it with Capacitor. Video plays natively in
  `frontend/android/`, with Media3/ExoPlayer, and libVLC as a fallback for
  streams Media3 can't play. The channel banner, mini guide, audio and
  subtitle menu and sleep timer are drawn natively too, so they work on top of
  the video. TV builds also get launcher rows, a launcher banner, frame rate
  matching and remote control navigation everywhere.
- **Windows** wraps it with Electron (`frontend/electron/`). Video plays in
  mpv, which comes with the installer, because Chromium can't decode HEVC.
- **A browser** can run the same build, minus the parts that need a device
  (talking to the provider directly, keeping everything locally).

**The device talks to the provider itself, never through a server.** Most
providers allow only one connection per subscription, so the app is careful.
It reads the catalogue once and keeps it on the device (SQLite on Android and
Windows), downloads a guide only when it's due rather than at every start,
and stops a channel preview as soon as focus moves away.

**Without an account, everything stays on the device.** Signing in adds sync.
When you sign out, you can keep everything on the device or clear it.

## Shared code (`shared/`)

Plain TypeScript used by the app, the sync service, the CLI and the tests:
the Xtream client, the M3U reader, XMLTV guides and channel matching, the sync
protocol, encryption, the family rules and profile pictures. Keeping it in one
place is what makes the app and the CLI behave the same way.

## The sync service (`worker/`, `server/`)

A Cloudflare Worker with a D1 (SQLite) database. Devices send what changed and
fetch what changed since they last asked. The newest change wins. Deletions
are kept as markers, so a favourite you removed stays removed on every device.

`server/` is the same service packed for the **Deploy to Cloudflare** button
and for `tvinto server init`. It's generated from `worker/` by
`worker/scripts/build-server.mjs`, and a test fails if it's out of date.

### What the service can and can't read

Your password never reaches the service. On your device, scrypt turns it into
two separate keys, and neither can be worked out from the other:

- **`auth`** is sent when you sign in. The service only stores a hash of it.
- **`enc`** never leaves your device. It encrypts (AES-256-GCM) each provider
  login and each guide address. Xtream guide addresses contain the username
  and password, which is why they're encrypted too.

So a copy of the database doesn't give away any provider login or guide
address, and there's no key on the server to steal along with it. Families
need one more step. Each account has a key pair, with the private key
encrypted under that account's own `enc`. That lets a parent's device encrypt
a subscription for a family member, and lets a member's `enc` be shared with
the people who manage their account.

What the service **can** read: account names, favourites, watch history,
settings, channel matches, list order, profile pictures, and who belongs to
which family. If you want to keep that to yourself, run your own service.

What this doesn't protect against: a service that is actively malicious could
hand out a public key of its own, just as it could serve a modified app. The
design assumes you trust the service you sign in to. It doesn't assume you
trust its database.

### Sessions and limits

Signing in gives you a session token, which the service stores hashed. Tool
sessions (the CLI and MCP) can do less. They can't change passwords, invites
or accounts, they can't see watch history unless you allowed it when signing
in, and they're rate limited. Wrong passwords are counted per name and per
connection. Sign-up can be `open`, `first-only` (the first account, then by
invite) or `closed`.

## The command line and MCP server (`cli/`)

`tvinto` signs in as one more device and changes an account through the same
sync feed the apps use: providers, guides, channel matches, sorting, hidden
and locked categories, player settings, the family and profile pictures.
Every change is shown first as a preview with a short code, and only applied
with that code. Changes are logged locally and can be undone. The MCP server
offers the same commands to an AI agent. The key that unlocks encrypted data
stays in your operating system's credential store, and nothing secret ever
shows up in the tool's output. Text that came from a provider, a guide or
another person is marked as untrusted.

## Updates

The Windows app updates itself with electron-updater. On Android, the web
part of the app updates by itself: a bundle is downloaded in the background
over HTTPS, its hash is checked before it's unpacked, and it's used from the
next launch. If it fails to start three times, it's thrown away. When the
native part changes, the app offers a new APK, checks its hash, and hands it
to Android's installer. Both come from GitHub Releases.

## Tests

`backend/` is the original Express server. It's now mostly the place where
the tests for `shared/`, `worker/` and `cli/` run, about 1,500 of them. The
Worker's tests run against a real SQLite database through a D1 shim.
`frontend/` has its own Jest setup (plain TypeScript and Angular). Android has
JUnit tests for the native player's logic.
