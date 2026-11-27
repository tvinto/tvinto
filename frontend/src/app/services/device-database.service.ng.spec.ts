import { TestBed } from '@angular/core/testing';
import { DeviceDatabaseService } from './device-database.service';

jest.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' } }));
jest.mock('@capacitor-community/sqlite', () => {
  const db = {
    isDBOpen: jest.fn(async () => ({ result: true })),
    query: jest.fn(async () => ({ values: [] })),
    executeSet: jest.fn(async () => ({ changes: { changes: 1 } }))
  };
  return {
    db,
    listeners: {} as Record<string, () => void>,
    CapacitorSQLite: { addListener: jest.fn(), untilFolded: jest.fn() },
    SQLiteConnection: jest.fn(() => ({ isConnection: async () => ({ result: true }), retrieveConnection: async () => db }))
  };
});

const { db, CapacitorSQLite: plugin } = jest.requireMock('@capacitor-community/sqlite');
const listeners: Record<string, () => void> = {};
let folded!: () => void;
plugin.addListener.mockImplementation(async (event: string, listener: () => void) => (listeners[event] = listener));
plugin.untilFolded.mockImplementation(() => new Promise<void>(resolve => (folded = resolve)));

describe('DeviceDatabaseService on Android', () => {
  it('turns off SQLite folding the log in at the end of a write', async () => {
    await TestBed.inject(DeviceDatabaseService).connect();
    expect(db.query).toHaveBeenCalledWith('PRAGMA wal_autocheckpoint = 0');
  });

  it('holds writes, not reads, while the log is folded in after "foldDue"', async () => {
    const connection = await TestBed.inject(DeviceDatabaseService).connect();
    listeners['foldDue']();
    await new Promise(settled => setTimeout(settled, 0));
    expect(plugin.untilFolded).toHaveBeenCalledTimes(1);

    let wrote = false;
    const write = connection.executeSet([]).then(() => (wrote = true));
    await connection.query('SELECT 1');
    await new Promise(settled => setTimeout(settled, 0));
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
    expect(wrote).toBe(false);

    folded();
    await write;
    expect(db.executeSet).toHaveBeenCalledTimes(1);
  });

  it('folds again for a notice that comes while a fold is finishing', async () => {
    plugin.untilFolded.mockClear();
    TestBed.inject(DeviceDatabaseService);
    listeners['foldDue']();
    listeners['foldDue']();
    await new Promise(settled => setTimeout(settled, 0));
    expect(plugin.untilFolded).toHaveBeenCalledTimes(1);
    folded();
    await new Promise(settled => setTimeout(settled, 0));
    expect(plugin.untilFolded).toHaveBeenCalledTimes(2);
  });
});
