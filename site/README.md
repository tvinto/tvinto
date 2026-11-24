# The website

The page at tvinto.app (for now a `*.pages.dev` address): plain HTML, CSS and
images, with no build step.

## How it is deployed

Cloudflare Pages, connected to the GitHub repository:

- Production branch: `main`
- Framework preset: None. Build command: empty. Build output directory: `site`
- Root directory: empty (the repository root), so Pages finds `functions/`
  there.

`functions/android.ts` and `functions/windows.ts` answer `/android` and
`/windows` with a redirect to the current APK and Windows installer, read from
the `feed` release (`android-apk.json`, `latest.yml`) and cached for a minute.
If the feed cannot be read they send people to the releases page instead. The
TV's Downloader code points at `/android`, so that address must not change.
The code itself is written once, in `index.html` (`close__code`).

`_headers` sets caching and security headers.

## Previewing it

From the repository root:

```bash
npx wrangler pages dev site --port 8812
```

To try `/android` and `/windows` without asking GitHub, serve a folder holding
`android-apk.json` and `latest.yml` and point the functions at it:
`--binding FEED=http://127.0.0.1:<port>`.
