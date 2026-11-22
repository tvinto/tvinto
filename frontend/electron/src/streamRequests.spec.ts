import { streamRequestLine } from './streamRequests';

describe('streamRequestLine', () => {
  it('says where each new range request starts', () => {
    expect(streamRequestLine({ prefix: 'curl', level: 'v', text: 'stream level seek from 65536 to 230763182\n' })).toBe(
      'mpv: a new request to the provider, from byte 230763182 (it was at byte 65536)'
    );
  });

  it('says why the requests after a track chosen mid-film come', () => {
    expect(streamRequestLine({ prefix: 'mkv', text: 'refresh seek to 15.520000' })).toBe(
      'mpv: reads again from 15.5 s for a track chosen while playing (refresh seek)'
    );
    expect(streamRequestLine({ prefix: 'lavf', text: 'refresh seek to -1.560000' })).toBe(
      'mpv: reads again from 0.0 s for a track chosen while playing (refresh seek)'
    );
  });

  it('leaves the opening to the app’s own line, which never carries the address either', () => {
    expect(streamRequestLine({ prefix: 'curl', text: 'Opening http://user:secret@example.test/movie/user/secret/1.mkv' })).toBeNull();
    expect(streamRequestLine({ prefix: 'stream_callback', text: 'Opening http://example.test/1.mkv' })).toBeNull();
    expect(streamRequestLine({ prefix: 'cplayer', text: 'Opening done: http://example.test/1.mkv' })).toBeNull();
  });

  it('leaves out what is not a request to the provider', () => {
    expect(streamRequestLine({ prefix: 'file', text: 'stream level seek from 10 to 0' })).toBeNull();
    expect(streamRequestLine({ prefix: 'mkv', text: 'select track 4' })).toBeNull();
    expect(streamRequestLine({ prefix: 'curl', text: 42 })).toBeNull();
    expect(streamRequestLine({})).toBeNull();
  });
});
