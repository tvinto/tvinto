package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

public class SkipTimesTest {

    private static final long EPISODE = 50 * 60_000L;

    private static SkipTimes.Chapter chapter(String title, long startMs) {
        return new SkipTimes.Chapter(title, startMs, -1L);
    }

    @Test
    public void offersTheIntroWhileItPlaysAndALittleEarly() {
        SkipTimes times = new SkipTimes(Collections.singletonList(new SkipTimes.Skip(SkipTimes.INTRO, 60_000L, 100_000L)));

        assertNull(times.at(50_000L));
        assertEquals(SkipTimes.INTRO, times.at(59_000L).kind);
        assertEquals(SkipTimes.INTRO, times.at(90_000L).kind);
        assertNull(times.at(99_000L));
    }

    @Test
    public void neverOffersTheCreditsAsASkipButSaysWhereTheyStart() {
        SkipTimes times = new SkipTimes(Collections.singletonList(new SkipTimes.Skip(SkipTimes.CREDITS, 47 * 60_000L, EPISODE)));

        assertNull(times.at(48 * 60_000L));
        assertEquals(47 * 60_000L, times.creditsStartMs());
        assertEquals(-1L, SkipTimes.none().creditsStartMs());
    }

    @Test
    public void readsChaptersNamedForWhatTheyAre() {
        SkipTimes times = SkipTimes.fromChapters(Arrays.asList(
            chapter("Previously on", 0L),
            chapter("Opening Credits", 70_000L),
            chapter("The flooded station", 120_000L),
            chapter("End Credits", 47 * 60_000L)), EPISODE);

        assertEquals(SkipTimes.RECAP, times.at(10_000L).kind);
        assertEquals(SkipTimes.INTRO, times.at(80_000L).kind);
        assertNull(times.at(119_000L));
        assertEquals(47 * 60_000L, times.creditsStartMs());
    }

    @Test
    public void leavesAPostCreditsSceneAndEarlyCreditsAlone() {
        SkipTimes times = SkipTimes.fromChapters(Arrays.asList(
            chapter("Chapter 1", 0L),
            chapter("Credits", 10 * 60_000L),
            chapter("Post-credits scene", 49 * 60_000L)), EPISODE);

        assertTrue(times.isEmpty());
    }

    @Test
    public void takesCreditsLateInTheFileEvenWithoutSayingTheEnd() {
        SkipTimes times = SkipTimes.fromChapters(Arrays.asList(chapter("Story", 0L), chapter("Credits", 45 * 60_000L)), EPISODE);

        assertEquals(45 * 60_000L, times.creditsStartMs());
    }

    @Test
    public void ignoresChaptersWithOrdinaryNames() {
        SkipTimes times = SkipTimes.fromChapters(Arrays.asList(chapter("Chapter 1", 0L), chapter("Chapter 2", 600_000L)), EPISODE);

        assertTrue(times.isEmpty());
    }
}
