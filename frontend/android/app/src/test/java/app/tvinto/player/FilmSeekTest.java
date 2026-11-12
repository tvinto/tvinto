package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public class FilmSeekTest {

    private static final long FILM = (2 * 3600 + 46 * 60) * 1000L;
    private static final long AT = (1 * 3600 + 12 * 60 + 40) * 1000L;

    @Test
    public void stepsGrowTheLongerAKeyIsHeld() {
        assertEquals(10_000L, FilmSeek.stepFor(0));
        assertEquals(10_000L, FilmSeek.stepFor(1999));
        assertEquals(30_000L, FilmSeek.stepFor(2000));
        assertEquals(60_000L, FilmSeek.stepFor(4000));
    }

    @Test
    public void pressesMoveTheTargetNotThePicture() {
        FilmSeek seek = new FilmSeek();
        seek.press(1, 0, AT, FILM);
        seek.press(1, 300, AT + 999_999, FILM);

        assertEquals(AT, seek.from());
        assertEquals(AT + 20_000L, seek.target());
    }

    // PL-TV-5b: "Opposite direction subtracts rather than restarting."
    @Test
    public void theOtherWaySubtractsFromTheTarget() {
        FilmSeek seek = new FilmSeek();
        seek.press(1, 0, AT, FILM);
        seek.press(1, 0, AT, FILM);
        seek.press(-1, 0, AT, FILM);

        assertEquals(AT + 10_000L, seek.target());
    }

    @Test
    public void staysInsideTheFilm() {
        FilmSeek seek = new FilmSeek();
        seek.press(-1, 0, 4_000L, FILM);
        assertEquals(0L, seek.target());

        FilmSeek forward = new FilmSeek();
        forward.press(1, 5000, FILM - 20_000L, FILM);
        assertEquals(FILM - 5_000L, forward.target());
    }

    @Test
    public void backPutsTheTargetWhereItStarted() {
        FilmSeek seek = new FilmSeek();
        seek.press(1, 0, AT, FILM);
        seek.cancel();

        assertFalse(seek.isActive());
        assertEquals(AT, seek.target());
    }

    @Test
    public void writesTimesAsTheBoardsDo() {
        assertEquals("1:12:40", FilmSeek.clock(AT));
        assertEquals("0:41:05", FilmSeek.clock((41 * 60 + 5) * 1000L));
        assertEquals("−1:33:20", FilmSeek.remaining(FILM - AT - 0));
        assertEquals("+1:30", FilmSeek.offset(90_000L));
        assertEquals("−0:10", FilmSeek.offset(-10_000L));
        assertEquals("+30 s", FilmSeek.tapOffset(30_000L));
        assertEquals("30 s steps", FilmSeek.stepLabel(30_000L));
        assertEquals("1 min steps", FilmSeek.stepLabel(60_000L));
        assertEquals("2 h 46 min", FilmSeek.runtime(FILM));
        assertEquals("46 min", FilmSeek.runtime(46 * 60_000L));
        assertEquals("", FilmSeek.runtime(0));
    }
}
