# Your own Tvinto sync service

Tvinto works on a single device without any account. An account is what lets
your phone, TV and computer share favourites, history, guides and settings,
and that account lives on a sync service. This folder is that service. You
run it on your own free Cloudflare account, so none of your data is kept by
anyone else.

Your provider login and your guides are encrypted on your devices before they
get here, and only your devices have the key. The service can't read them, and
neither can anyone who gets access to it.

## Setting it up

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tvinto/tvinto/tree/main/server)

1. Press the button and sign in to Cloudflare, or create an account. The free
   plan is enough.
2. Keep the names it suggests, or pick your own.
3. For `ACCOUNT_SALT_SECRET`, enter any long random text and don't share it.
   `openssl rand -hex 32` makes one, and so does any password manager.
4. Press Deploy. About a minute later you get your service's address,
   something like `https://tvinto-sync.yourname.workers.dev`.

## Using it

1. In the app, on the sign-in page, enter that address as the server and
   press "Use this server".
2. Create your account. The first account on a new service doesn't need a
   code.
3. Everyone after that needs an invite code. You make those in the app, on
   Account, under "Invite someone".

You can change who may sign up with `ACCOUNT_REGISTRATION`, in your Worker's
settings in the Cloudflare dashboard:

- `first-only` (the default): only the first account, then invite codes
- `open`: anyone who knows the address
- `closed`: nobody, not even with a code

## Managing your account from the command line

Once your service is running, you can also change your setup with the
`tvinto` command line tool, or let an AI agent like Claude do it through MCP.
Sign it in with your service's address:

```bash
tvinto sign-in --server https://tvinto-sync.yourname.workers.dev
```

The app asks you to allow it. Every change is shown first and only happens
once you confirm it. See the [command line guide](https://github.com/tvinto/tvinto/blob/main/cli/README.md).

## Optional: descriptions and subtitles

TMDB gives films and shows their descriptions in your language, genres,
Popular this week, More like this, scores, trailers and the age rating lock.
OpenSubtitles lets people add subtitles to films and episodes.

Each needs its own free key: from
[themoviedb.org](https://www.themoviedb.org/settings/api) and
[opensubtitles.com](https://www.opensubtitles.com/consumers). In the
Cloudflare dashboard, open your Worker, then Settings, then Variables and
Secrets, and add them as secrets named `TMDB_API_KEY` and
`OPENSUBTITLES_API_KEY`. You add them once, and everyone on your service gets
them. Without them the app tells you those features aren't set up, and
everything else still works.

For subtitles, each person also links their own free OpenSubtitles account in
the app (Account, then Subtitles). A free account allows 20 downloads a day,
and subtitles someone adds are saved to their account for all their devices.

## Looking after it

- **Backups.** On the free plan, Cloudflare can restore the database to any
  minute in the last 7 days (D1 Time Travel). Your devices also keep their own
  copies and send them back the next time they sync.
- **Logs.** When something fails, the service logs it. You can see it in the
  Cloudflare dashboard, on your Worker, under Logs. Normal requests are not
  logged.
- **Wrong passwords.** After ten wrong tries for the same name, that
  connection has to wait fifteen minutes before trying again.
- **Cost.** A household fits easily in the free plan: 100,000 requests a day
  and a database of up to 500 MB. One account takes a few kilobytes.

## Without the button

If you have the tvinto command line tool, one command does everything. Run it
again later in the same folder to update the service:

```bash
tvinto server init
```

It puts the service in a `tvinto-server` folder and runs wrangler,
Cloudflare's own tool, which signs you in to Cloudflare in your browser.
tvinto never sees your Cloudflare login. It also creates
`ACCOUNT_SALT_SECRET` for you, without showing it or keeping a copy.

Or do it by hand from this folder, with Node installed:

```bash
npm install
npx wrangler login
npx wrangler deploy                              # creates the database the first time
npx wrangler d1 migrations apply DB --remote     # creates its tables
npx wrangler secret put ACCOUNT_SALT_SECRET
```

After the first time, `npm run deploy` applies any new migrations and then
deploys.

## What's in this folder

`src/worker.js` is generated from `worker/` in the Tvinto repository, with
the code it shares with the apps bundled in. Make changes there, not here.
