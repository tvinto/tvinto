# The sync service

This is what's left of a backend once the devices talk to the provider
themselves.

It remembers who you are and what you've set up: your account, favourites,
list order, history and settings. Nothing else. No catalogue, no video, no
guide, no provider login it can read, and no password. It stores about nine
kilobytes per person.

If you just want your own copy running, the easier route is the Deploy button
in [`server/README.md`](../server/README.md). This file is for working on the
service itself.

## Why there's no password here

On the free plan a Worker gets 10 ms of CPU per request, and hashing a
password with scrypt at the strength this app uses takes about a hundred. So
the device does the hashing and sends a key instead, and the service stores a
hash of that key. Two things follow from this:

- Your account password never reaches the service.
- A copy of the database is worthless to an attacker. Your subscription is
  stored encrypted, under a key made from your password, and that key never
  leaves your device. Nobody can get a provider password out of it, or a
  guide address either. (A guide address counts as a password too, since it
  looks like `xmltv.php?username=…&password=…`.)

The key derivation lives in `shared/auth/accountKeys.ts`. The devices and the
Express backend use the same file, so they can't drift apart.

## Running it locally

```bash
npm install
npx wrangler d1 execute xtream --local --file=./schema.sql
npx wrangler dev
```

`ACCOUNT_SALT_SECRET` comes from `.dev.vars`, which git ignores.
`.dev.vars.example` lists what can go in it. To make one:

```bash
node -e "console.log('ACCOUNT_SALT_SECRET=\"' + require('crypto').randomBytes(32).toString('base64') + '\"')" > .dev.vars
```

Without it, the salt endpoint refuses to answer instead of making a secret
up. A Worker has nowhere to keep a value it generated (the next instance
would make a different one), and a salt that changed between two requests
would give away exactly what it's meant to hide: whether an account exists.

## Deploying it by hand

```bash
npx wrangler login
cp wrangler.example.toml wrangler.toml  # your own copy, ignored by git
npx wrangler d1 create xtream          # prints a database_id; put it in wrangler.toml
npx wrangler d1 execute xtream --remote --file=./schema.sql
npx wrangler secret put ACCOUNT_SALT_SECRET
npx wrangler deploy
```

Then enter its address in the app at sign-in. Once everyone who needs an
account has one, set `ACCOUNT_REGISTRATION = "closed"` in `wrangler.toml`.
The service can be reached from anywhere.

**If `--remote --file` fails with `Authentication error [code: 10000]`**, the
token from `wrangler login` is missing a permission that the bulk import
needs. `--command` uses a different endpoint and works with the same token,
so you can run the statements one at a time:

```bash
npx wrangler d1 execute xtream --remote --yes --command "CREATE TABLE IF NOT EXISTS ..."
```

**If your database was created before a schema change**, apply that change's
file from `migrations/` the same way, before deploying the Worker that needs
it. Then read the columns back (each file says how). A command that prints no
error hasn't necessarily run.

**Backups.** D1 can restore a database to any minute in the last 7 days on
the free plan, or 30 days on the paid plan (Time Travel). A restore
overwrites the database in place and prints a bookmark you can use to undo
it:

```bash
npx wrangler d1 time-travel info xtream --timestamp="2026-10-23T18:00:00+02:00"
npx wrangler d1 time-travel restore xtream --timestamp=<unix seconds>
```

Devices keep their own copies too. Favourites, history and settings come back
from any device that still has them, the next time it syncs.

**Logs.** When something fails, the Worker logs it. You can read the logs in
the Cloudflare dashboard, under the Worker's Logs, for 3 days on the free plan
(`[observability]` in `wrangler.toml`). Per-request logs are turned off,
because every request carries a session token in a header.

## The query limit, and how it shaped the design

On the free plan a Worker can make 50 D1 queries per request. That limit
changed how the service works:

- **A push reads once per kind of data and writes everything in one batch.**
  The Express backend does a SELECT and an INSERT per change. That's fine
  against a local file but impossible here.
- **A push carries at most 20 changes.** If a device sends more, the service
  says so, and the device splits them up. That's how a first sync gets broken
  into pieces.
- **A list's order is one row of JSON, not one row per position.** One real
  account has 830 live categories. A row per position would mean 830
  statements just to save one drag, and the request would fail.

`worker/src/worker.test.ts` counts the queries and checks them. A limit nobody
measures is a limit nobody keeps.

## No clock that never repeats

The Express backend gives out sync cursors from a counter, because a change
saved in the same millisecond as a pull would look equal to the cursor and get
skipped forever (the next pull asks for an even later moment).

A Worker has no single process to keep such a counter in. So the cursor lags
one second behind, and the next pull reads that second again. A change can
arrive twice, but never not at all. Receiving it twice does nothing, because
"newest change wins" doesn't treat an equal timestamp as newer.

## Tests

They run with the backend's tests, because SQLite is already set up there:

```bash
cd ../backend && npx jest worker
```

D1 is SQLite, so the tests run the same SQL that runs in production. What a
test setup can't prove is the Worker runtime itself, so the handlers were also
tried over HTTP against `wrangler dev` with a local D1: sign-up, signing in
with a key, a push and pull including the 830-item list order, the batch
limit, settings, and the encrypted subscription.

## Guides

Guides add two more kinds of change, and they work differently.

**A guide source can't be read by the service.** Its name, address and
on/off switch are encrypted with `enc`. The service only holds an id, an
owner, a timestamp and the encrypted data. It doesn't need to read the
address: "newest change wins" works fine on data nobody can open. The id is a
hash of the address, which is what lets it be a row's key on a server that
can't read anything else about it.

**A channel match can be read.** A stream id, a guide id and a channel id like
`HTV1.hr` don't give anything away. Keeping them readable means each match can
be its own row, with deletion markers, instead of one big encrypted blob. That
matters because people match channels by hand (almost half of one real line-up
had no channel id at all), and two devices editing matches must not quietly
throw away each other's work.

Which guides a device has actually *downloaded* stays on that device. A guide
can be tens of megabytes, and a phone on mobile data should get a choice. So a
new device is offered the missing guides instead of being made to download
them.

## Moving an account to a different service

There's no export, no import, and no transfer between servers. A device
already holds the account's favourites, history, list order, guides and
channel matches, because that's what lets it work without a server. So moving
just means one device telling a new service everything it knows.

This works because the sync cursor belongs to one server. A cursor means
"everything up to here has reached that service". A device that kept an old
cursor would ask a new service for changes since last Tuesday, be told there
are none, and never send anything. So with a service it has no cursor for,
the device assumes the service has never seen it and sends everything.

1. Sign out in the app, choose the new service on the sign-in page, and enter
   its address.
2. **Create the account** there. Don't sign in, because the new service has
   never seen this account. Use the same username and password. The password
   still never leaves the device, and using the same one means guides and the
   subscription are encrypted under the same key as before. With
   `ACCOUNT_REGISTRATION = "first-only"` only one account gets through, so if
   something goes wrong, delete that row before trying again:

   ```bash
   npx wrangler d1 execute xtream --remote --yes --command "DELETE FROM users"
   ```

3. Everything else happens by itself. The device sees it has no cursor for
   this service, queues everything it has, and sends it twenty changes at a
   time. The subscription goes too, encrypted, but only if the service doesn't
   already have one. An old device with an expired login must not overwrite a
   renewal made somewhere else.
4. Set `ACCOUNT_REGISTRATION = "closed"` and deploy again.

**Going back just means choosing the old service again.** It still has
everything, the device's own copy was never touched, and each service has its
own cursor, so the device picks up where it left off.

## Hosting your own update feed (optional)

The apps update from the project's releases on GitHub, so most people never
need this. If you build the apps yourself and want them to update from your
own service instead, `GET /updates/<file>` serves files from an R2 bucket. The
Windows app's updater asks for `latest.yml`, reads the version, and then
downloads the installer it names. Android reads `android-latest.json` and
`android-apk.json` in the same way.

This route answers before any sign-in check, on purpose. An app asking for a
newer version has nobody signed in, and it's running the very code it's about
to replace. A bug in accounts must not be able to block its own fix.

**Why not use the bucket's own public URL?** An `r2.dev` address belongs to
Cloudflare. Every installed copy would have it built in, with no way to move
them if it ever had to change. Your own address is yours.

To turn it on:

```bash
# 1. Enable R2 in the Cloudflare dashboard. It's free, but it asks for billing
#    details before it lets you create a bucket.
npx wrangler r2 bucket create xtream-updates
# 2. Uncomment the [[r2_buckets]] block in wrangler.toml, then:
npx wrangler deploy
```

Then set `updatesUrl` in `frontend/config.local.json` to your service's
`/updates` address before building. Without a bucket, `/updates/` answers 503
rather than 404, because "that version doesn't exist" and "updates aren't set
up here" send you looking in opposite directions. `/downloads`, `/a` and `/w`
then point at the project's GitHub releases.

The bucket stays private. Nothing in it is secret (an installer is meant to be
downloaded), but "not secret" isn't the same as "reachable at a public URL
forever".

## Not done yet

**The Windows installer isn't signed.** Windows warns about an unknown
publisher the first time it's installed. `electron-updater` only checks the
SHA-512 in the manifest, and the manifest comes from the same place as the
file, so it proves the download wasn't corrupted, not that it came from us. A
code signing certificate would fix that, but it costs money.
