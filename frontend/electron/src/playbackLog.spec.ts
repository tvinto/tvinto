import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { playbackLog, redactText, redactUrl, setPlaybackLogFolder } from './playbackLog';

describe('the playback log', () => {
  it('names a stream by its channel number only', () => {
    expect(redactUrl('http://provider.example:8080/live/someone/secret/1234.m3u8')).toBe('http …/1234.m3u8');
    expect(redactUrl('https://provider.example/live/someone/secret/77.ts?token=abc')).toBe('https …/77.ts');
  });

  it('says nothing of a last part that could be a name or a token', () => {
    expect(redactUrl('http://provider.example/get.php?username=someone&password=secret')).toBe('http …');
    expect(redactUrl('http://provider.example/live/someone/secret/')).toBe('http …');
    expect(redactUrl('http://provider.example/stream/mychannel.m3u8')).toBe('http …');
  });

  it('redacts an address anywhere in a line', () => {
    const line = redactText("failed for 'http://someone:secret@provider.example/live/someone/secret/9.m3u8' (500)");
    expect(line).toBe("failed for 'http …/9.m3u8' (500)");
    expect(line).not.toMatch(/someone|secret|provider/);
  });

  it('writes each line with the time to playback.log', () => {
    const folder = mkdtempSync(join(tmpdir(), 'playback-log-'));
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      setPlaybackLogFolder(folder);
      playbackLog('app: opens http://provider.example/live/a/b/5.m3u8');
      const text = readFileSync(join(folder, 'playback.log'), 'utf8');
      expect(text).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z app: opens http …\/5\.m3u8\n$/);
      expect(info).toHaveBeenCalledWith('[playback] app: opens http …/5.m3u8');
    } finally {
      info.mockRestore();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
