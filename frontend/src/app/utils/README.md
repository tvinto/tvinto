# Utilities

Plain functions with no Angular in them, one topic per file, each with a
`.spec.ts` beside it. They run in the fast "plain" Jest project, without a
TestBed, so put logic here when you can and keep services thin.

A few you'll run into early:

- `date-time.utils.ts`: reading and formatting XMLTV and Unix times, and how
  far through a programme we are.
- `guide.utils.ts`: guide data per stream, and how far back the guide grid
  reads.
- `stream.utils.ts`: stream types, URL checks, and `safeToLog`, which strips
  login details from a URL before it's logged.
- `i18n.ts`: the `t()` translation function (the strings are in `../i18n/`).
- `failure-messages.utils.ts`: turning errors into what a person sees, with
  the technical detail kept for the error dialog.
- `web-update.utils.ts` and `app-update.utils.ts`: when an Android device
  takes a new web bundle or offers a new APK.
- `sync-queue.utils.ts`: the queue of changes waiting to be sent to the sync
  service.

`index.ts` re-exports some of them, but most code imports the file it needs
directly.
