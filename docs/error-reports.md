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
  when playback started and stopped and why. A line repeated several times in
  a row is sent once, with how many times. A stream is named only by its type
  (`http …/[stream].mkv`), not by the provider's number for it. The log on your
  computer keeps the numbers; only the copy in a report loses them.
- When the Android app crashes or stops responding: where in its code, and
  what each of its threads was doing at the time (function names, not data).

### Failures that show no error

Some things fail without anything in the app going wrong: the provider does
not answer. Each of these is one report with a short code and a few numbers:

| What failed | What the report says |
|---|---|
| A stream that won't start, or stops and doesn't come back | which player (Media3, VLC, the desktop's, the page's), its error code, whether it was live TV, a film or an episode, the file type (ts, m3u8, mkv), the codec when the player named one, the HTTP status, how many seconds it played, and for a live channel that showed no picture, how long it waited (20 seconds) |
| A guide that won't load | at which stage (opening, downloading, reading), the HTTP status, whether it was too large, its size in whole megabytes and how many programmes it got to |
| A sync that fails | which call (sending changes or fetching them) and the HTTP status. Not while the device is offline |
| TMDB or OpenSubtitles failing | the HTTP status, nothing else |

Each has a plain title that says what failed, such as "Stream failed: live,
tvinto-player, no picture", and failures with the same title are grouped
together. Crashes and other errors are grouped by Sentry as usual, by where
in the code they happened.

Closing the player yourself is never a failure: pressing Back or Escape,
closing it, or choosing another channel sends nothing, even when the stream
never started.

A provider having a bad evening would otherwise send one of these for every
channel tried, so they are grouped: at most one report of each failure (each title) every five
minutes, and the one at the end of the five minutes says how many there were.

## What a report never holds

- Your provider's address, username or password, or the address of any stream.
- The names of channels, films, shows, episodes or programmes, or anything
  about what you watch.
- Your Tvinto account's name or email, or your sync server's address.
- TMDB or OpenSubtitles keys.
- Your IP address. The app doesn't send it, and it asks the report service not
  to work it out from the connection either.
- Where you are. Sentry works out a city and a country from the connection
  when a report has no location of its own, even when it stores no IP
  address. So every report carries a location that says "not sent", which
  leaves Sentry nothing to fill in.
- The provider's numbers for streams, which with the provider's list would say
  what you watched.
- Your computer's name or the names of your folders.

What Sentry records for each report, then, is exactly what is listed under
"What a report holds", the time it arrived, and that location of "not sent".

Every report goes through one cleaning step on your device before it leaves
([shared/errorReports.ts](../shared/errorReports.ts)). It takes out every web
address, anything that looks like a login, a key or an email address, and the
values the app actually holds for you, wherever they turn up in the report.
Tests plant a made-up provider's details in each part of a report and check
that none of them come out.

The values include every title the app has read: the channels, films and shows
of the library, the episodes of a show, the guide's programmes -- whatever was
on a screen, played or only scrolled past -- both as the provider names them
("EN - Never Surrender (2026)") and as the app shows them ("Never Surrender").
Each is taken out wherever it stands, as `[title]`
([shared/heldTitles.ts](../shared/heldTitles.ts)). Titles shorter than three
letters are left, as taking them out would empty every message.

When the desktop app itself crashes, the report says which part crashed and
how. It doesn't include a memory dump, because a dump is a copy of the app's
memory, and that could hold your provider's login.

The Android app is the same: a crash in its Java code, in the players' native
code or in a plugin, and the app not responding, are reported without a
memory dump, a tombstone or a thread dump. Android's crash reports are kept on
the device, in the app's own folder, and handed to the same cleaning step as
everything else before anything is sent. A crash usually ends the app, so its
report waits on the device until the next start, and is sent then only if the
switch is on; with the switch off it is deleted.

## Only errors

There are no usage statistics, no record of the screens you visit or what you
press, and no recordings of your screen.

## When

Only when something fails: a JavaScript error in the app, an error or a crash
in the desktop or the Android app, the desktop player stopping unexpectedly,
or one of the failures in the table above. Nothing is
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
reporting part doesn't even start the next time you open the app; on Android,
it stops at once, deletes any crash reports kept on the device, and doesn't
start again until the switch is on.

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

On Android, build the app with the stand-in's address as the emulator sees
it (`http://fakekey@10.0.2.2:8790/1`). A debug build can rehearse a crash and
the app not responding from the page:
`Capacitor.Plugins.ErrorReports.rehearse({ what: 'crash' })` or
`{ what: 'anr' }` (then press a key: Android closes the app that stopped
answering). Both reports arrive at the next start. A release build refuses.
