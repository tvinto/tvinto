# Contributing to Tvinto

Thanks for wanting to help. Issues, ideas and pull requests are all welcome.

## Before you start

- **Read [docs/building.md](docs/building.md)**, especially "Worth knowing
  before you start".
- **For anything bigger than a small fix, open an issue first.** That way we
  can agree on the approach before you put in the work.
- **Look for issues labelled `good first issue`** if you want something small
  to start with.

## Ground rules

- **Tvinto is only a player.** No bundled playlists, no suggested providers,
  no "free TV" wording. Screenshots, tests and examples use made up or
  free-to-air content, never real channel logos, films or a provider's
  address.
- **Never hammer a provider.** Most providers allow one connection per
  subscription. Nothing may download a provider's whole catalogue over and
  over, open lots of streams quickly, or poke at it in the background. Develop
  against `tools/qa/fake-xtream.js` instead.
- **Nothing secret in logs, tests or output.** No provider address, username
  or password in a log line, and no real login in a test. Use `console.info`
  for log lines you want to keep. `console.log` is for debugging and fails
  the linter.
- **The sync service only sees what it has to.** Provider logins and guide
  addresses are encrypted on the device before they are sent. Keep it that
  way.
- **Every setting in the app is also in the CLI.** If you add a setting, add
  its `tvinto` command too, and put the logic in `shared/` so the app and the
  tool can't drift apart.
- **The TV matters as much as anything else.** Everything has to be reachable
  and readable with a remote from across the room. Focus is always visible,
  nothing works only on hover, and nobody types on the TV when a phone could
  do it instead.

## Pull requests

- One change per pull request, with a description of what it does and why.
- **Tests:** `npx jest` and `npx eslint . --max-warnings 0` must pass in both
  `backend/` and `frontend/`. CI runs them for you. Add tests for what you
  change.
- **Look at it.** If your change is visible, check it on screen (on the TV
  emulator for TV work) and add a screenshot to the pull request.
- **Comments explain why, not what.** Say why a line is the way it is, or what
  went wrong without it. The code relies on this a lot, so please keep it up.
- **Text on screen** comes in 16 languages, one file each in
  `frontend/src/app/i18n/` (`Texts.java` has English and Croatian built in for
  the native player). Add new words in English to every file, and say in the
  pull request which ones still need translating; a test checks that no file
  is missing a word.

## Licence

By contributing, you agree that your work is published under the project's
licences: GNU GPL v3 for the apps and GNU AGPL v3 for the sync service
(`worker/` and `server/`).
