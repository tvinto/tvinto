import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { fromAppPage } from './appPage';
import { BookRequest, DesktopRecorder, StartRequest } from './recorder';

let recorder: DesktopRecorder | null = null;

/**
 * The recorder (src/recorder.ts), once, after the app is ready. An installed
 * app records into Videos\Tvinto, where people look for video; a copy run
 * from source into its own data folder, so a test run fills nobody's Videos.
 */
export function desktopRecorder(): DesktopRecorder {
  if (!recorder) {
    const dir = app.isPackaged ? join(app.getPath('videos'), 'Tvinto') : join(app.getPath('userData'), 'Recordings');
    recorder = new DesktopRecorder(dir, join(app.getPath('userData'), 'recording-bookings.json'), id => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('xtream:recorder-changed', id);
      }
    });
    recorder.reschedule();
    app.on('will-quit', () => recorder?.close());
  }
  return recorder;
}

/** What the page may ask of the recorder: what Android's RecorderPlugin answers. */
export function registerRecorder(): void {
  const answer = <T>(channel: string, work: (input: never) => T | Promise<T>) =>
    ipcMain.handle(channel, (event, input) => (fromAppPage(event) ? work(input as never) : Promise.reject(new Error('Not the app'))));

  answer('xtream:recorder-start', (input: StartRequest) => desktopRecorder().start(input));
  answer('xtream:recorder-stop', (input: { id: string }) => desktopRecorder().stop(String(input?.id)));
  answer('xtream:recorder-watch', (input: { id: string }) => desktopRecorder().watchAddress(String(input?.id)));
  answer('xtream:recorder-list', () => ({ recordings: desktopRecorder().list() }));
  answer('xtream:recorder-remove', (input: { id: string }) => ({ removed: desktopRecorder().remove(String(input?.id)) }));
  answer('xtream:recorder-book', (input: BookRequest) => desktopRecorder().book(input));
  answer('xtream:recorder-cancel', (input: { id: string }) => desktopRecorder().cancelBooking(String(input?.id)));
  answer('xtream:recorder-bookings', () => ({ bookings: desktopRecorder().bookings() }));
}
