import { PIPE_OPENS_WITHIN_MS, PipeOpening, playerPipeName } from './playerPipe';

describe('playerPipeName', () => {
  it('gives the players of two copies of the app different pipes', () => {
    const installed = playerPipeName(4120);
    const development = playerPipeName(9876);
    expect(installed).not.toBe(development);
    expect(installed).toContain('-4120-');
    expect(development).toContain('-9876-');
  });

  it('gives two players of one copy different pipes', () => {
    expect(playerPipeName()).not.toBe(playerPipeName());
  });

  it('keeps apart two copies that were given the same process id', () => {
    expect(playerPipeName(4120)).not.toBe(playerPipeName(4120));
  });

  it('is a Windows pipe name, and no longer the shared one', () => {
    const name = playerPipeName(4120, 'abc');
    expect(name).toBe('\\\\.\\pipe\\tvinto-player-4120-abc');
    expect(name).not.toContain('xtream-mpv');
  });
});

describe('PipeOpening', () => {
  const make = () => {
    let now = 1_000;
    const lines: string[] = [];
    const opening = new PipeOpening('\\\\.\\pipe\\tvinto-player-1-a', line => lines.push(line), () => now);
    return { opening, lines, later: (ms: number) => (now += ms) };
  };

  it('says nothing while the player is still opening its pipe', () => {
    const { opening, lines, later } = make();
    later(PIPE_OPENS_WITHIN_MS - 1);
    opening.failed('ENOENT');
    expect(lines).toEqual([]);
  });

  it('says once that the pipe never opened', () => {
    const { opening, lines, later } = make();
    later(PIPE_OPENS_WITHIN_MS);
    opening.failed('ENOENT');
    opening.failed('ENOENT');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('has not opened');
    expect(lines[0]).toContain('ENOENT');
  });

  it('says nothing of a pipe that went away after it had opened', () => {
    const { opening, lines, later } = make();
    opening.opened();
    later(PIPE_OPENS_WITHIN_MS * 2);
    opening.failed('ENOENT');
    expect(lines).toEqual([]);
  });

  it('says when a pipe it gave up on opened after all', () => {
    const { opening, lines, later } = make();
    later(PIPE_OPENS_WITHIN_MS);
    opening.failed('ENOENT');
    opening.opened();
    expect(lines[1]).toContain('opened late');
  });
});
