import { CopyFallbackService } from './copy-fallback.service';

const SHOW = [
  { stream_id: 1, name: 'EN - Severance FHD (2022)' },
  { stream_id: 2, name: 'EN - Severance 1080p (2022)' },
  { stream_id: 3, name: 'DE - Severance FHD (2022)' },
  { stream_id: 4, name: 'EN - Severance HD (2022)' }
];
const GONE = { errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 404)', positionSeconds: 0 };

describe('trying copies one after another', () => {
  it('goes through the copies without trying one twice, three at most', () => {
    const copies = new CopyFallbackService();
    const tried = [copies.next(SHOW[0], SHOW, GONE, 0)];
    tried.push(copies.next(tried[0]!, SHOW, GONE, 0));
    tried.push(copies.next(tried[1]!, SHOW, GONE, 0));

    expect(tried.map(copy => copy?.stream_id)).toEqual([2, 3, 4]);
    expect(copies.next(tried[2]!, SHOW, GONE, 0)).toBeNull();
  });

  it('starts afresh once a copy has played', () => {
    const copies = new CopyFallbackService();
    copies.next(SHOW[0], SHOW, GONE, 0);
    copies.played();

    expect(copies.tried(SHOW[0])).toBe(false);
    expect(copies.next(SHOW[0], SHOW, GONE, 0)?.stream_id).toBe(2);
  });

  it('does not count a copy that was passed over without being opened', () => {
    const copies = new CopyFallbackService();
    const lacking = copies.next(SHOW[0], SHOW, GONE, 0)!;
    copies.passOver(lacking);
    const second = copies.next(SHOW[0], SHOW, GONE, 0)!;
    const third = copies.next(second, SHOW, GONE, 0)!;

    expect([lacking.stream_id, second.stream_id, third.stream_id]).toEqual([2, 3, 4]);
  });

  it('puts a copy that failed last for a day, until it plays', () => {
    localStorage.clear();
    const copies = new CopyFallbackService();
    copies.next(SHOW[0], SHOW, GONE, 0);
    const listed = SHOW.map(stream => ({ stream }));

    expect(copies.inPlayOrder(listed).map(copy => copy.stream.stream_id)).toEqual([2, 3, 4, 1]);

    copies.played(SHOW[0]);
    expect(copies.failedRecently(SHOW[0])).toBe(false);
  });

  it('does not hold a refusal of the account against the copy', () => {
    localStorage.clear();
    const copies = new CopyFallbackService();
    copies.next(SHOW[0], SHOW, { errorCode: 'ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 403)', positionSeconds: 0 }, 0);

    expect(copies.failedRecently(SHOW[0])).toBe(false);
  });

  it('leaves a copy that failed after its first minute alone', () => {
    const copies = new CopyFallbackService();

    expect(copies.next(SHOW[0], SHOW, { ...GONE, positionSeconds: 540 }, 500)).not.toBeNull();
    expect(copies.next(SHOW[0], SHOW, { ...GONE, positionSeconds: 700 }, 500)).toBeNull();
  });
});
