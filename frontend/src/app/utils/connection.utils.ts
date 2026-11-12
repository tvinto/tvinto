/**
 * Whether the system says the connection is metered or saving data.
 *
 * Chromium on Android reports a type and a data-saver flag; the desktop
 * reports neither, and a desktop is not the device this worries about.
 * Unknown is not treated as metered, or no guide would ever download by
 * itself.
 */
export function isMeteredConnection(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; type?: string } }).connection;
  return !!connection && (connection.saveData === true || connection.type === 'cellular');
}
