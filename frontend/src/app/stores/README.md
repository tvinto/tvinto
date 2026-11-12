# Stores

NgRx signal stores. Each one holds some screen state as signals and loads it
through `XtreamService`.

- **`dashboard.store.ts`** (`DashboardStore`) is shared by the whole app
  (`providedIn: 'root'`). It holds the categories and streams on screen, the
  search, and the guide for the visible channels. It puts the device's own
  guide on screen as soon as it's read, without waiting for any backend
  answer (`guideOnScreen`). Tested in `dashboard.store.ng.spec.ts`.
- **`series-detail.store.ts`** (`SeriesDetailStore`) holds one series: its
  seasons, the chosen season and that season's episodes.
- **`epg.store.ts`** (`EpgStore`) holds the programme guide for one channel.

`index.ts` re-exports all three.

Two things to keep in mind:

- **The app is zoneless.** A template only updates when a signal it reads
  changes, so anything a screen shows goes into store state (or another
  signal), never a plain field.
- **A slow backend must never hold up what the device already knows.** Put
  answers on screen as each one arrives. Don't wait for several together with
  `forkJoin`.
