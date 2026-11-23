import { cleanReport } from '@shared/errorReports';
import { removeTitles } from '@shared/heldTitles';
import { heldTitleFilter, notingTitles, noteShowTitles } from './held-titles';

class Store {
  // A private field, as the real stores have: the proxy must call through to the store itself.
  #rows = [{ name: 'EN - Never Surrender (2026)' }, { name: '|HR| Quiet Harbour [4K]' }];
  async recentlyAdded(): Promise<{ name: string }[]> {
    return this.#rows;
  }
  async writeStreams(): Promise<number> {
    return this.#rows.length;
  }
}

describe('held titles', () => {
  it('takes a title that was only browsed past out of a report, as the screen showed it', async () => {
    const store = notingTitles(new Store(), ['recentlyAdded']);
    await store.recentlyAdded();
    expect(await store.writeStreams()).toBe(2);

    const event = { message: 'Poster missing for Never Surrender and Quiet Harbour', extra: { row: 'EN - Never Surrender (2026)' } };
    const text = JSON.stringify(removeTitles(cleanReport(event, []), heldTitleFilter()));
    expect(text).not.toContain('Never Surrender');
    expect(text).not.toContain('Quiet Harbour');
    expect(text).toContain('Poster missing for [title] and [title]');
  });

  it('holds a show and its episodes', () => {
    noteShowTitles({ info: { name: 'Fake Show Sixty' }, episodes: { '1': [{ title: 'The Long Way Round' }] } });
    expect(heldTitleFilter()('Fake Show Sixty: The Long Way Round failed')).toBe('[title]: [title] failed');
  });
});
