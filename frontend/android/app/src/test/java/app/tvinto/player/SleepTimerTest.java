package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Test;

import java.util.List;

public class SleepTimerTest {

    private static final long NOW = 1_791_300_000_000L;
    private static final long MINUTE = 60_000L;

    @After
    public void reset() {
        SleepTimer.cancel();
        Texts.use(null);
    }

    private static SleepTimer.Choice find(List<SleepTimer.Choice> choices, SleepTimer.Kind kind, int minutes) {
        for (SleepTimer.Choice choice : choices) {
            if (choice.kind == kind && choice.minutes == minutes) {
                return choice;
            }
        }
        throw new AssertionError("no " + kind + " " + minutes);
    }

    @Test
    public void offersOffAndTheTimesOnAChannelWithNoGuide() {
        List<SleepTimer.Choice> choices = SleepTimer.choices(NOW, 0L, null);
        assertEquals(7, choices.size());
        assertEquals(SleepTimer.Kind.OFF, choices.get(0).kind);
        assertEquals("Off", choices.get(0).label());
        assertEquals("15 minutes", choices.get(1).label());
        assertEquals("120 minutes", choices.get(6).label());
    }

    @Test
    public void offersTheEndOfTheProgrammeOnlyWhenItIsWorthWaitingFor() {
        assertEquals(8, SleepTimer.choices(NOW, NOW + 40 * MINUTE, null).size());
        assertEquals(SleepTimer.Kind.PROGRAMME, SleepTimer.choices(NOW, NOW + 40 * MINUTE, null).get(7).kind);
        // Ending in a minute: the warning alone would be longer.
        assertEquals(7, SleepTimer.choices(NOW, NOW + MINUTE, null).size());
        // Already over.
        assertEquals(7, SleepTimer.choices(NOW, NOW - MINUTE, null).size());
    }

    @Test
    public void offersTheEndOfAFilmOrAnEpisode() {
        List<SleepTimer.Choice> film = SleepTimer.choices(NOW, 0L, false);
        assertEquals("End of this film", film.get(film.size() - 1).label());
        List<SleepTimer.Choice> episode = SleepTimer.choices(NOW, 0L, true);
        assertEquals("End of this episode", episode.get(episode.size() - 1).label());
        Texts.use("hr");
        assertEquals("Kraj ove epizode", episode.get(episode.size() - 1).label());
        assertEquals("30 minuta", episode.get(2).label());
    }

    @Test
    public void countsDownFromWhenItWasChosen() {
        SleepTimer.choose(find(SleepTimer.choices(NOW, 0L, null), SleepTimer.Kind.MINUTES, 30), NOW);
        assertTrue(SleepTimer.isOn(NOW));
        assertEquals(30 * MINUTE, SleepTimer.remainingMs(NOW));
        assertEquals("30 min left", SleepTimer.summary(NOW));
        // Part of a minute counts as one.
        assertEquals("23 min left", SleepTimer.summary(NOW + 7 * MINUTE + 1));
        assertFalse(SleepTimer.ranOut(NOW + 30 * MINUTE - 1));
        assertTrue(SleepTimer.ranOut(NOW + 30 * MINUTE));
        assertFalse(SleepTimer.isOn(NOW + 30 * MINUTE));
    }

    @Test
    public void stopsWhenTheProgrammeEnds() {
        long end = NOW + 40 * MINUTE;
        SleepTimer.choose(find(SleepTimer.choices(NOW, end, null), SleepTimer.Kind.PROGRAMME, 0), NOW);
        assertEquals(40 * MINUTE, SleepTimer.remainingMs(NOW));
        assertTrue(SleepTimer.ranOut(end));
    }

    @Test
    public void waitsForTheEndOfWhatPlaysWithoutATime() {
        SleepTimer.choose(find(SleepTimer.choices(NOW, 0L, true), SleepTimer.Kind.ITEM, 0), NOW);
        assertTrue(SleepTimer.endsWithItem());
        assertTrue(SleepTimer.isOn(NOW + 500 * MINUTE));
        assertFalse(SleepTimer.ranOut(NOW + 500 * MINUTE));
        assertEquals(0L, SleepTimer.remainingMs(NOW));
        assertEquals("Until the end", SleepTimer.summary(NOW));
    }

    @Test
    public void keepWatchingAddsHalfAnHourToWhenItWouldHaveStopped() {
        SleepTimer.choose(find(SleepTimer.choices(NOW, 0L, null), SleepTimer.Kind.MINUTES, 15), NOW);
        long warned = NOW + 14 * MINUTE + 30_000L;
        SleepTimer.keepWatching(warned);
        assertEquals(45 * MINUTE, SleepTimer.remainingMs(NOW));
        // No longer any one of the rows.
        assertNull(SleepTimer.chosen());
    }

    @Test
    public void offIsOff() {
        SleepTimer.choose(find(SleepTimer.choices(NOW, 0L, null), SleepTimer.Kind.MINUTES, 60), NOW);
        SleepTimer.choose(SleepTimer.choices(NOW, 0L, null).get(0), NOW);
        assertFalse(SleepTimer.isOn(NOW));
        assertNull(SleepTimer.summary(NOW));
        assertFalse(SleepTimer.ranOut(NOW + 500 * MINUTE));
        assertNull(SleepTimer.chosen());
    }

    @Test
    public void saysTheLastMinuteAndFadesTheLastSeconds() {
        assertEquals("0:59", SleepTimer.countdown(58_200L));
        assertEquals("1:00", SleepTimer.countdown(60_000L));
        assertEquals("0:05", SleepTimer.countdown(5_000L));
        assertEquals(1f, SleepTimer.volume(30_000L), 0f);
        assertEquals(0.5f, SleepTimer.volume(5_000L), 0.001f);
        assertEquals(0f, SleepTimer.volume(0L), 0f);
    }

    @Test
    public void tellsWhoeverListensAndOnlyThem() {
        int[] heard = { 0 };
        Runnable first = () -> heard[0]++;
        Runnable second = () -> heard[0] += 10;
        SleepTimer.listen(first);
        SleepTimer.cancel();
        assertEquals(1, heard[0]);
        SleepTimer.listen(second);
        // The first player closing must not deafen the second.
        SleepTimer.stopListening(first);
        SleepTimer.cancel();
        assertEquals(11, heard[0]);
        SleepTimer.stopListening(second);
        SleepTimer.cancel();
        assertEquals(11, heard[0]);
    }
}
