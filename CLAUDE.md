# Working in this repository

Notes for AI coding assistants, and for anyone else. Read
[docs/building.md](docs/building.md) first. Its "Worth knowing before you
start" section lists the things that have actually cost time here. Then read
[CONTRIBUTING.md](CONTRIBUTING.md) for the project's ground rules.

## The most important rules

- **Never use a real IPTV provider in tests or automation.** Use
  `tools/qa/fake-xtream.js`. Real providers usually allow one connection, and
  a script that hammers one can get the account blocked.
- **Never put a provider's address, username or password in a log line, a
  test or a commit.** Use `console.info` for log lines you want to keep.
- **Never press OK blindly in a script that drives the TV emulator.** Check
  where the focus is first, because a blind OK can start a stream.
- **Look at the screen.** Passing tests don't prove a view updates (the app is
  zoneless and the TestBeds aren't), and a number that changed doesn't prove
  the feature works.
- **Every customisable feature also gets a `tvinto` command**, with its logic
  in `shared/`.

## Commands

```bash
cd backend  && npx jest && npx eslint . --max-warnings 0
cd frontend && npx jest && npx eslint . --max-warnings 0 && npm run build
node worker/scripts/build-server.mjs     # after changing worker/
backend/node_modules/.bin/tsc -p cli     # type-checks the CLI (its build doesn't)
```

## Personal notes

A maintainer's own notes (their devices, their sync service, their plans) go
in `CLAUDE.local.md`, which Claude Code reads along with this file, and in
`private/`. Git ignores both.
