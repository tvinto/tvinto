# The backend

This is Tvinto's original server, built with Node.js, Express and TypeScript.
Back then the server talked to the IPTV provider and the apps talked to the
server. Now the apps talk to the provider directly and sync through the
Cloudflare Worker in `worker/`, so you don't need this server to use Tvinto.

It stays for two reasons:

- **It runs the tests** for `shared/`, `worker/` and `cli/` (about 1,500 of
  them), because it already has Jest and a real SQLite set up. The Worker's
  tests run against SQLite through a D1 shim.
- **It still works** as a self-hosted server for older setups. Copy
  `.env.example` to `.env` and read the comments in it, since every setting is
  explained there.

## Commands

```bash
npm install
npx jest                         # every test in the repository except the app's
npx eslint . --max-warnings 0    # CI fails on any warning
npm run dev                      # runs the server and restarts it on changes
npm run build && npm run start:prod
```

## Folders

```
src/
├── app.ts, server.ts   the Express app and its entry point
├── routes/             the API routes
├── controllers/        what each route does
├── services/           talking to the provider, the database, accounts
├── middleware/         checking the session on each request
├── config/, types/     settings and types
├── utils/              small helpers (and the source encoding test)
└── test-utils/         helpers for the tests
```

## Licence

GNU GPL v3, like the apps. See [LICENSE](../LICENSE).
