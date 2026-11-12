package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class FrameRateMatchTest {

    private static FrameRateMatch.Mode mode(int id, float rate) {
        return new FrameRateMatch.Mode(id, 3840, 2160, rate);
    }

    /** What a typical 4K television offers. */
    private static final FrameRateMatch.Mode[] TELEVISION = {
        mode(1, 60f), mode(2, 59.94f), mode(3, 50f), mode(4, 30f), mode(5, 29.97f),
        mode(6, 25f), mode(7, 24f), mode(8, 23.976f),
        new FrameRateMatch.Mode(9, 1920, 1080, 50f)
    };

    private static int chosen(float rate, int currentId) {
        FrameRateMatch.Mode current = TELEVISION[currentId - 1];
        FrameRateMatch.Mode best = FrameRateMatch.bestMode(TELEVISION, current, rate);
        return best == null ? -1 : best.id;
    }

    @Test
    public void aEuropeanChannelGetsFiftyRatherThanTwentyFive() {
        assertEquals(3, chosen(25f, 1));
        assertEquals(3, chosen(50f, 1));
    }

    @Test
    public void aFilmGetsItsOwnRateNotTheOneBesideIt() {
        assertEquals(8, chosen(23.976f, 1));
        assertEquals(7, chosen(24f, 1));
    }

    @Test
    public void americanRatesKeepTheirFractions() {
        assertEquals(2, chosen(29.97f, 1));
        assertEquals(1, chosen(30f, 3));
    }

    @Test
    public void aModeThatAlreadyFitsIsKeptSoTheScreenDoesNotBlink() {
        assertEquals(3, chosen(25f, 3));
        assertEquals(3, chosen(50f, 3));
    }

    @Test
    public void theScreensResolutionIsKept() {
        FrameRateMatch.Mode current = TELEVISION[0];
        assertEquals(3, FrameRateMatch.bestMode(TELEVISION, current, 50f).id);
    }

    @Test
    public void nothingIsChosenWhenNothingFits() {
        FrameRateMatch.Mode[] only60 = { mode(1, 60f) };
        assertNull(FrameRateMatch.bestMode(only60, only60[0], 25f));
        assertEquals(1, FrameRateMatch.bestMode(only60, only60[0], 30f).id);
    }

    @Test
    public void aMeasurementSettlesOnTheStandardRateNextToIt() {
        assertEquals(25f, FrameRateMatch.snap(25.04f), 0.0001f);
        assertEquals(23.976f, FrameRateMatch.snap(23.98f), 0.0001f);
        assertEquals(24f, FrameRateMatch.snap(23.995f), 0.0001f);
        assertEquals(59.94f, FrameRateMatch.snap(59.95f), 0.0001f);
        assertEquals(12.5f, FrameRateMatch.snap(12.5f), 0.0001f);
    }
}
