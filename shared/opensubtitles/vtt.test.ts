import { shiftWebVtt, toWebVtt } from './vtt';

/**
 * What OpenSubtitles actually hands over: usually WebVTT, sometimes the SRT the
 * file was uploaded as, and -- when something is wrong at their end -- an error
 * page that must not be saved as a subtitle.
 */

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Dobar dan.',
  '',
  '2',
  '00:01:02,250 --> 00:01:04,000',
  '<i>Tko je to?</i>',
  'Ne znam.',
  ''
].join('\r\n');

describe('subtitles as the players want them', () => {
  it('turns an SRT into WebVTT, keeping the text and dropping the cue numbers', () => {
    expect(toWebVtt(SRT)).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:03.500',
        'Dobar dan.',
        '',
        '00:01:02.250 --> 00:01:04.000',
        '<i>Tko je to?</i>',
        'Ne znam.',
        ''
      ].join('\n')
    );
  });

  it('pads times an SRT wrote short', () => {
    expect(toWebVtt('1\n0:01:2,5 --> 0:01:4,25\nHi\n')).toContain('00:01:02.500 --> 00:01:04.250');
  });

  it('leaves a WebVTT file alone, apart from its BOM and line endings', () => {
    const vtt = '﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n';

    expect(toWebVtt(vtt)).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n');
  });

  it('mends a file that says WEBVTT and then writes SRT timings', () => {
    expect(toWebVtt('WEBVTT\n\n00:00:01,000 --> 00:00:02,000\nHello\n')).toContain('00:00:01.000 --> 00:00:02.000');
  });

  it('drops the SubStation tags their converted files carry', () => {
    // What the first added subtitle drew on the television, literally.
    expect(toWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an8}i vjetar brzine do 50 km/h,\n')).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ni vjetar brzine do 50 km/h,\n'
    );
    expect(toWebVtt('1\n00:00:01,000 --> 00:00:02,000\n{\\pos(192,210)}Zdravo\n')).toContain('\nZdravo\n');
  });

  it('refuses what is not subtitles, so nothing empty is saved', () => {
    expect(toWebVtt('')).toBeNull();
    expect(toWebVtt('   \n\n')).toBeNull();
    expect(toWebVtt('<html><body>Error 503</body></html>')).toBeNull();
  });
});

describe('moving subtitles earlier or later', () => {
  const VTT = ['WEBVTT', '', '00:00:28.583 --> 00:00:31.916', 'Prvi red.', '', '00:01:09.250 --> 00:01:10.792', 'Drugi red.', ''].join('\n');

  it('moves every cue later', () => {
    expect(shiftWebVtt(VTT, 1500)).toContain('00:00:30.083 --> 00:00:33.416');
    expect(shiftWebVtt(VTT, 1500)).toContain('00:01:10.750 --> 00:01:12.292');
  });

  it('moves every cue earlier', () => {
    expect(shiftWebVtt(VTT, -2000)).toContain('00:00:26.583 --> 00:00:29.916');
  });

  it('never moves a cue before the start', () => {
    expect(shiftWebVtt(VTT, -60_000)).toContain('00:00:00.000 --> 00:00:00.000');
  });

  it('carries seconds into minutes and minutes into hours', () => {
    expect(shiftWebVtt('WEBVTT\n\n00:59:59.500 --> 00:59:59.900\nKraj.\n', 1000)).toContain(
      '01:00:00.500 --> 01:00:00.900'
    );
  });

  it('leaves the text alone, including a clock inside a line', () => {
    const quoting = 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nVlak u 00:00:10.000 sati.\n';

    expect(shiftWebVtt(quoting, 1000)).toBe('WEBVTT\n\n00:00:11.000 --> 00:00:13.000\nVlak u 00:00:10.000 sati.\n');
  });

  it('does nothing at all for no offset', () => {
    expect(shiftWebVtt(VTT, 0)).toBe(VTT);
  });
});
