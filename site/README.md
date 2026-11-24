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
The code itself is written once, in `index.html` (the `close__code` element, a placeholder `00000` until it is registered).

`_headers` sets caching and security headers.

`404.html` matters more than it looks: without it Pages treats the site as a
single-page app and answers every address, `/robots.txt` and typos included,
with the home page and a 200. `robots.txt` allows everything.

Once the domain exists, add to the `<head>` of `index.html`
`<link rel="canonical" href="https://tvinto.app/">` and
`<meta property="og:url" content="https://tvinto.app/">`, make `og:image`
absolute (`https://tvinto.app/share.jpg`), and add a one-line `sitemap.xml` and
its `Sitemap:` line in `robots.txt` (both need the full address).

## Previewing it

From the repository root:

```bash
npx wrangler pages dev site --port 8812
```

To try `/android` and `/windows` without asking GitHub, serve a folder holding
`android-apk.json` and `latest.yml` and point the functions at it:
`--binding FEED=http://127.0.0.1:<port>`.
