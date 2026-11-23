# What Tvinto sends

People rarely report problems by hand, so the official Tvinto apps send an
error report by themselves when something goes wrong. This page says exactly
what that means.

## What a report holds

- What went wrong: the error's message and where in the app's code it
  happened.
- The app's version, so problems can be grouped by version.
- The kind of device and system: for example Windows 11, an Android TV model,
  the screen size.
- Which screen it happened on, by name only (Live TV, Movies), never which
  channel or film.
- On the computer, the last 50 lines of the app's own playback log, which says
  when playback started and stopped and why.

## What a report never holds

- Your provider's address, username or password, or the address of any stream.
- The names of channels, films or shows, or anything about what you watch.
- Your Tvinto account's name or email, or your sync server's address.
- TMDB or OpenSubtitles keys.
- Your IP address. The app doesn't send it, and it asks the report service not
  to work it out from the connection either.
- Your computer's name or the names of your folders.

Every report goes through one cleaning step on your device before it leaves
([shared/errorReports.ts](../shared/errorReports.ts)). It takes out every web
address, anything that looks like a login, a key or an email address, and the
values the app actually holds for you, wherever they turn up in the report.
Tests plant a made-up provider's details in each part of a report and check
that none of them come out.

When the desktop app itself crashes, the report says which part crashed and
how. It doesn't include a memory dump, because a dump is a copy of the app's
memory, and that could hold your provider's login.

## Only errors

There are no usage statistics, no record of the screens you visit or what you
press, and no recordings of your screen.

## When

Only when something fails: a JavaScript error in the app, an error or a crash
in the desktop app, or the desktop player stopping unexpectedly. Nothing is
sent before the first screen has shown you the switch.

## Where

To [Sentry](https://sentry.io), a service made for error reports, in the
project's own account. Only the people who work on Tvinto can read them.

## Turning it off

- In the app: Account, Playback, "Send error reports".
- On the first screen, when you start the app for the first time.
- From the command line: `tvinto error-reports off`.

The setting belongs to your account, so turning it off on one device turns it
off on all of them. Off means nothing is sent at all. On the computer, the
reporting part doesn't even start the next time you open the app.

## Building it yourself

A copy you build yourself, and any fork, sends nothing. Reports need an
address that only the project's own builds have. It goes in
`frontend/config.local.json`, which isn't part of the code:

```json
{ "errorReportsDsn": "https://<key>@<organisation>.ingest.sentry.io/<project>" }
```

Without it, the switch isn't shown and nothing is sent.

## Testing it

`node tools/qa/fake-sentry.js` stands in for Sentry on your own machine
(port 8790). Point a build at it with
`"errorReportsDsn": "http://fakekey@127.0.0.1:8790/1"`, then
`http://127.0.0.1:8790/qa/received` lists what arrived, and the files it saved
show the reports in full.
