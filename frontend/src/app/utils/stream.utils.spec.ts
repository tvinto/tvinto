import { getStreamType, isValidStreamUrl, safeToLog } from './stream.utils';

describe('safeToLog', () => {
  // A guide URL is the other shape a credential arrives in: not in the path,
  // as playback URLs have it, but in the query string.
  it('never prints the values in a guide URL query, whatever they are called', () => {
    const masked = safeToLog('http://mag.example/xmltv.php?username=c0ffee&password=hunter2');

    expect(masked).not.toContain('hunter2');
    expect(masked).not.toContain('c0ffee');
    expect(masked).toBe('http://mag.example (path hidden, query: username, password)');
  });

  it('hides the value of a token under any other name', () => {
    expect(safeToLog('http://guide.example/epg.xml.gz?key=SECRET&x=1')).toBe(
      'http://guide.example (path hidden, query: key, x)'
    );
  });

  const SECRET = 'provider-password';

  it('takes the credentials out of a live URL', () => {
    expect(safeToLog(`http://mag.example/live/c0ffee/${SECRET}/1402.m3u8`)).toBe(
      'http://mag.example/live/***/***/1402.m3u8'
    );
  });

  it('does the same for films and episodes', () => {
    expect(safeToLog(`http://mag.example/movie/c0ffee/${SECRET}/99.mp4`)).toBe(
      'http://mag.example/movie/***/***/99.mp4'
    );
    expect(safeToLog(`http://mag.example/series/c0ffee/${SECRET}/12.mkv`)).toBe(
      'http://mag.example/series/***/***/12.mkv'
    );
  });

  it('keeps a port, since that is worth seeing and is not secret', () => {
    expect(safeToLog(`http://mag.example:8080/live/c0ffee/${SECRET}/7.ts`)).toBe(
      'http://mag.example:8080/live/***/***/7.ts'
    );
  });

  it('leaves a backend ticket URL alone', () => {
    // It carries a short-lived opaque token, not credentials, and the whole
    // point of reading this line is to tell the two paths apart.
    const ticket = 'http://10.0.2.2:3000/api/streams/play/1402f8430e313eb8.m3u8';
    expect(safeToLog(ticket)).toBe(ticket);
  });

  it('hides the path of anything it does not recognise', () => {
    // Guessing wrong here means printing a password, so an unfamiliar shape
    // gets less said about it rather than more.
    expect(safeToLog('http://mag.example/something/else/entirely')).toBe(
      'http://mag.example (path hidden)'
    );
  });

  it('never returns the secret, whatever it is handed', () => {
    const shapes = [
      `http://mag.example/live/c0ffee/${SECRET}/1.m3u8`,
      `http://mag.example/live/c0ffee/${SECRET}/1.m3u8?token=${SECRET}`,
      `http://mag.example/odd/c0ffee/${SECRET}`,
      `http://mag.example/?password=${SECRET}`,
      `//mag.example/live/c0ffee/${SECRET}/1.m3u8`
    ];

    for (const shape of shapes) {
      expect(safeToLog(shape)).not.toContain(SECRET);
    }
  });

  it('says something harmless when there is no URL at all', () => {
    expect(safeToLog(undefined)).toBe('(none)');
    expect(safeToLog('')).toBe('(none)');
    expect(safeToLog('not a url')).toBe('(unparseable url)');
  });
});

describe('getStreamType', () => {
  it('prefers the stream\'s own type', () => {
    expect(getStreamType({ type: 'live', stream_type: 'vod' })).toBe('live');
  });

  it('falls back to stream_type, then to the caller\'s hint', () => {
    expect(getStreamType({ stream_type: 'series' })).toBe('series');
    expect(getStreamType({}, 'vod')).toBe('vod');
  });

  it('maps the provider\'s "movie" onto the "vod" the app uses', () => {
    // The two names for one thing that once made every VOD search return zero.
    expect(getStreamType({ type: 'movie' })).toBe('vod');
    expect(getStreamType({ stream_type: 'movie' })).toBe('vod');
    expect(getStreamType({}, 'movie' as never)).toBe('vod');
  });

  it('returns null when nothing identifies the stream', () => {
    expect(getStreamType({})).toBeNull();
    expect(getStreamType({ type: '' })).toBeNull();
  });
});

describe('isValidStreamUrl', () => {
  it('accepts http and https', () => {
    expect(isValidStreamUrl('http://provider.example/live/1.m3u8')).toBe(true);
    expect(isValidStreamUrl('https://provider.example/live/1.m3u8')).toBe(true);
  });

  it('rejects other schemes, including ones a page should never load', () => {
    expect(isValidStreamUrl('javascript:alert(1)')).toBe(false);
    expect(isValidStreamUrl('file:///etc/passwd')).toBe(false);
    expect(isValidStreamUrl('data:text/html,<script>')).toBe(false);
  });

  it('rejects anything that is not a URL', () => {
    expect(isValidStreamUrl('not a url')).toBe(false);
    expect(isValidStreamUrl('')).toBe(false);
    expect(isValidStreamUrl('/api/streams/play/abc.m3u8')).toBe(false);
  });
});
