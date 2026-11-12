import {
  ChangeSet,
  MAX_CHANGES_PER_PUSH,
  emptyChangeSet,
  isEmptyChangeSet,
  splitChangeSet
} from './sync';

/**
 * Cutting a batch down to what a Worker will accept.
 *
 * The interesting property is not that the pieces are small enough. It is that
 * putting them back together, in any order, means the same thing as the batch
 * they came from -- because the pieces are sent one at a time and any of them
 * can be the one that fails.
 */

const at = '2026-08-30T10:00:00.000Z';

const favourites = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    type: 'live' as const,
    streamId: String(index),
    name: null,
    updatedAt: at
  }));

const deletions = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    kind: 'favourite' as const,
    key: `live:gone-${index}`,
    deletedAt: at
  }));

const settings = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `setting-${index}`,
    value: 'x',
    updatedAt: at
  }));

const sizeOf = (batch: ChangeSet) =>
  batch.favourites.length +
  batch.arrangements.length +
  batch.progress.length +
  batch.settings.length +
  batch.deletions.length;

describe('splitChangeSet', () => {
  it('leaves a batch that already fits in one piece', () => {
    const batch = { ...emptyChangeSet(), favourites: favourites(5) };

    expect(splitChangeSet(batch, 20)).toEqual([batch]);
  });

  it('cuts a batch that does not fit', () => {
    const pieces = splitChangeSet({ ...emptyChangeSet(), favourites: favourites(45) }, 20);

    expect(pieces).toHaveLength(3);
    expect(pieces.map(sizeOf)).toEqual([20, 20, 5]);
  });

  it('counts every kind against the same limit', () => {
    // The limit is queries, not favourites. A batch of five of each is
    // twenty-five statements whichever kinds they are.
    const pieces = splitChangeSet(
      {
        ...emptyChangeSet(),
        favourites: favourites(10),
        settings: settings(10),
        deletions: deletions(5)
      },
      20
    );

    expect(pieces.every(piece => sizeOf(piece) <= 20)).toBe(true);
    expect(pieces.reduce((total, piece) => total + sizeOf(piece), 0)).toBe(25);
  });

  it('loses nothing and invents nothing', () => {
    const batch: ChangeSet = {
      ...emptyChangeSet(),
      favourites: favourites(23),
      settings: settings(7),
      deletions: deletions(11)
    };

    const pieces = splitChangeSet(batch, 20);
    const rejoined: ChangeSet = {
      favourites: pieces.flatMap(piece => piece.favourites),
      arrangements: pieces.flatMap(piece => piece.arrangements),
      progress: pieces.flatMap(piece => piece.progress),
      settings: pieces.flatMap(piece => piece.settings),
      guideSources: pieces.flatMap(piece => piece.guideSources),
      channelMappings: pieces.flatMap(piece => piece.channelMappings),
      deletions: pieces.flatMap(piece => piece.deletions)
    };

    expect(rejoined).toEqual(batch);
  });

  it('puts the deletions first', () => {
    const pieces = splitChangeSet(
      { ...emptyChangeSet(), favourites: favourites(30), deletions: deletions(3) },
      20
    );

    // Within any one piece the service applies deletions before adds, so a
    // removal and a re-add of the same thing resolve the way the timestamps
    // say rather than the way the array happened to be ordered.
    expect(pieces[0].deletions).toHaveLength(3);
    expect(pieces[1].deletions).toHaveLength(0);
  });

  it('gives back nothing for nothing', () => {
    expect(splitChangeSet(emptyChangeSet(), 20)).toEqual([]);
  });

  it('never returns an empty piece', () => {
    const pieces = splitChangeSet({ ...emptyChangeSet(), favourites: favourites(40) }, 20);

    // Exactly divisible is the case that produces a trailing empty one if the
    // flush is written carelessly, and an empty push is a wasted request.
    expect(pieces).toHaveLength(2);
    expect(pieces.every(piece => !isEmptyChangeSet(piece))).toBe(true);
  });

  it('refuses to be told a limit of nothing', () => {
    // A zero would otherwise loop forever, or produce a piece per nothing.
    const pieces = splitChangeSet({ ...emptyChangeSet(), favourites: favourites(3) }, 0);

    expect(pieces).toHaveLength(3);
  });

  it('defaults to the limit the service actually has', () => {
    const pieces = splitChangeSet({
      ...emptyChangeSet(),
      favourites: favourites(MAX_CHANGES_PER_PUSH + 1)
    });

    expect(pieces).toHaveLength(2);
  });
});
