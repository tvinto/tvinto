import { Stream } from '@shared/types';
import { GuideHit } from '@shared/xtream/guide';
import { MatchedChannel } from '@shared/xtream/guideMatching';
import { linkGuideHits } from './guide-search.utils';

const NOW = Date.parse('2026-10-06T20:00:00Z');
const MIN = 60_000;

const stream = (id: string, name: string): Stream => ({ stream_id: id, name }) as unknown as Stream;

const hit = (channel: string, startMin: number, title = 'Dnevnik', sourceId = 'epg'): GuideHit => ({
  sourceId,
  channel,
  start: NOW + startMin * MIN,
  stop: NOW + (startMin + 30) * MIN,
  title,
  description: '',
  category: ''
});

const matched = (channel: string, ...streamIds: string[]): [string, MatchedChannel] => [
  channel,
  { ref: { sourceId: 'epg', channelId: channel }, streamIds }
];

const streams = new Map([
  ['7', stream('7', 'HRT 1 HD')],
  ['8', stream('8', 'HRT 1 SD')],
  ['9', stream('9', 'N1')]
]);

describe('guide search results', () => {
  const byChannel = new Map([matched('HRT1.hr', '7', '8'), matched('n1.hr', '9')]);

  it('put each programme on a channel that can be watched, on now first, then soonest', () => {
    const found = linkGuideHits([hit('n1.hr', 120), hit('hrt1.hr', -10), hit('hrt1.hr', 60)], byChannel, streams, NOW);
    expect(found.map(one => [one.stream.name, one.onNow])).toEqual([
      ['HRT 1 HD', true],
      ['HRT 1 HD', false],
      ['N1', false]
    ]);
  });

  it('offer a programme once, though two guides and two copies of the channel carry it', () => {
    const found = linkGuideHits([hit('hrt1.hr', 60, 'Dnevnik', 'a'), hit('HRT1.hr', 60, 'Dnevnik', 'b')], byChannel, streams, NOW);
    expect(found).toHaveLength(1);
  });

  it('leave out what has finished, and what no channel here shows', () => {
    expect(linkGuideHits([hit('hrt1.hr', -60), hit('rtl.hr', 30)], byChannel, streams, NOW)).toEqual([]);
  });

  it('stop at the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => hit('n1.hr', i * 60));
    expect(linkGuideHits(many, byChannel, streams, NOW, 4)).toHaveLength(4);
  });
});
