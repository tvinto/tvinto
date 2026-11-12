# Security

Tvinto stores people's IPTV logins, encrypted, on sync services, both ours and
ones that other people run. If you find a way around that encryption, or
anything else that puts people at risk, please tell us privately first.

## Reporting a problem

Use GitHub's **private vulnerability reporting**: open the *Security* tab of
this repository and click *Report a vulnerability*. Tell us what you found,
how to reproduce it, and what it would let someone do. Please don't open a
public issue for it.

We'll reply within a week. Once the fix is released, we're happy to credit
you.

## What counts

- The sync service (`worker/`, `server/`): signing in, sessions, family
  permissions, tool sessions, and anything that reads data it shouldn't.
- The encryption (`shared/auth/`): anything that lets someone read a provider
  login or a guide address without the account's password.
- The apps: deep links, updates, the desktop app's IPC, and anything a
  playlist, guide or provider response could make the app do.
- The CLI and its MCP server, including an AI agent being tricked by text it
  reads through the tool into doing something nobody approved.

Not covered: a provider's own service, and sync services run by other people.
Those are theirs to look after.
