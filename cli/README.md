# tvinto: the command line and AI tool

`tvinto` changes your Tvinto account from a terminal, the same way the app
does: providers, guides, channel matches, sorting, hidden and locked
categories, player settings, profile pictures and the family. Every change
reaches all your devices through the sync service.

It also runs as an **MCP server**, so an AI agent such as Claude can do these
things for you. You stay in control: the agent can look and suggest, but a
change only happens after you confirm it.

## Install

It isn't on npm yet, so build it from this repository. You need Node.js 20 or
newer.

```bash
git clone https://github.com/tvinto/tvinto.git
cd tvinto/cli
npm install
npm run build
npm link        # puts the tvinto command on your PATH
```

Check it works with `tvinto --help`. If you'd rather not use `npm link`, run it
as `node <path to>/tvinto/cli/dist/tvinto.js` instead.

## Sign in

With an account on a sync service:

```bash
tvinto sign-in --server https://tvinto-sync.yourname.workers.dev
```

The Tvinto app on one of your devices asks whether to allow it. Press Allow,
and the app shows a short confirmation code. Type that code into the
terminal. This makes sure it really was you who allowed it. (Use `--password`
to type your password in the terminal instead.)

Without an account, using the Tvinto app on this computer:

```bash
tvinto sign-in --local
```

The app asks you to allow it, and tvinto then works on what that app keeps.

By default tvinto can't see your favourites or watch history. Add
`--history` when signing in if you want it to.

## Use it

Look around first. These only read:

```bash
tvinto status
tvinto providers
tvinto categories live
tvinto channels <category id> --suggest   # suggests a guide for channels without one
```

Changes are made in two steps. A command first tells you what it will do and
gives you a code. Nothing changes until you apply that code, within five
minutes:

```bash
tvinto hide live 12 15
#   Hides 2 live categories: Sport, Kids
#   Nothing has changed yet. To do this: tvinto apply K7P2  (five minutes)
tvinto apply K7P2
tvinto undo        # puts the last change back
```

Some examples:

```bash
tvinto sort channels name_asc
tvinto order live 3 1 7                  # these categories first
tvinto match <guide id> <channel id> <guide channel id>
tvinto player subtitle-language en
tvinto age-lock 12
tvinto picture fox
tvinto family role anna kid
```

`tvinto --help` lists everything. Add `--json` to any command for output a
script can read, and `--for <name>` to work on a family member's settings.

## Use it with an AI agent (MCP)

Sign in first (above). Then add tvinto to your agent as an MCP server. For
Claude Code:

```bash
claude mcp add tvinto -- tvinto mcp
```

Other MCP clients need the command `tvinto mcp` (or
`node <path to>/cli/dist/tvinto.js mcp`) in their settings.

The agent can then read your setup and prepare changes. When it wants to
apply one, your agent app asks **you** to confirm, showing the change. If
your agent app can't ask, the agent tells you to run `tvinto apply <code>` in
a terminal yourself. Either way the agent can't apply a change on its own.

## What it can't do

- It can't change your password, invite people or change who is in the
  family. Those stay in the app. Adding or removing a family member and
  resetting a password are *asked of the app*, which does them when you click.
- It never shows a provider login or a full provider address, and nothing
  secret goes through it. The key that unlocks encrypted data stays in your
  operating system's credential store.
- Text that came from a provider, a guide or another person (channel names,
  for example) is marked as untrusted, so an agent doesn't take it as
  instructions.

## Your own sync service

`tvinto server init` sets up a sync service on your own Cloudflare account.
See [server/README.md](../server/README.md). `tvinto server tmdb-key`, in the
same folder, gives it a TMDB key, so every app signed in to it gets posters,
descriptions and Popular without typing a key of its own.
