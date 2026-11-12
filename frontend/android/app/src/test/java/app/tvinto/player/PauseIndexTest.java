package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Where a step behind live lands in a pause's file, and what the local server is asked for. */
public class PauseIndexTest {

    /** A channel arriving at 188 000 bytes a second from second 100, noted every quarter second. */
    private static PauseIndex steady(int seconds) {
        PauseIndex index = new PauseIndex();
        for (long ms = 0; ms <= seconds * 1000L; ms += 250L) {
            index.wrote(100_000L + ms, ms * 188L);
        }
        return index;
    }

    @Test
    public void knowsNothingBeforeAnythingArrived() {
        PauseIndex index = new PauseIndex();
        assertEquals(-1L, index.first());
        assertEquals(-1L, index.last());
        assertNull(index.at(5L));
    }

    @Test
    public void findsWhatWasLiveAtAMoment() {
        PauseIndex.Spot spot = steady(60).at(130_000L);
        assertEquals(130_000L, spot.arrived);
        assertEquals(30L * 188_000L, spot.offset);
    }

    @Test
    public void takesThePlaceNotedJustBeforeAndStartsAtAPacket() {
        PauseIndex index = new PauseIndex();
        index.wrote(1_000L, 0L);
        index.wrote(1_300L, 1_000L);
        index.wrote(1_600L, 2_000L);
        PauseIndex.Spot spot = index.at(1_500L);
        assertEquals(1_300L, spot.arrived);
        assertEquals(940L, spot.offset);
    }

    @Test
    public void neverBeforeTheStart() {
        PauseIndex.Spot spot = steady(10).at(0L);
        assertEquals(100_000L, spot.arrived);
        assertEquals(0L, spot.offset);
    }

    @Test
    public void notesAtMostEveryQuarterSecondButKeepsTheNewestMoment() {
        PauseIndex index = new PauseIndex();
        index.wrote(1_000L, 0L);
        index.wrote(1_100L, 500L);
        index.wrote(1_200L, 900L);
        assertEquals(1_000L, index.at(1_200L).arrived);
        assertEquals(1_200L, index.last());
    }

    @Test
    public void growsPastItsFirstRoom() {
        PauseIndex index = steady(600);
        assertEquals(100_000L, index.first());
        assertEquals(700_000L, index.last());
        assertEquals(599L * 188_000L, index.at(699_100L).offset);
    }

    private static long request(String text) throws IOException {
        return LivePause.requested(new ByteArrayInputStream(text.getBytes(StandardCharsets.ISO_8859_1)), "ab12");
    }

    @Test
    public void servesThePauseFromItsStart() throws IOException {
        assertEquals(0L, request("GET /pause/ab12.ts HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
    }

    @Test
    public void servesAStepFromWhereItWent() throws IOException {
        assertEquals(37_600L, request("GET /pause/ab12.ts?from=37600 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
    }

    @Test
    public void answersARangeAsOne() throws IOException {
        assertEquals(LivePause.RANGED + 1_880L, request("GET /pause/ab12.ts HTTP/1.1\r\nRange: bytes=1880-\r\n\r\n"));
    }

    @Test
    public void refusesAnythingElse() throws IOException {
        assertEquals(-1L, request("GET /pause/other.ts HTTP/1.1\r\n\r\n"));
        assertEquals(-1L, request("GET /pause/ab12.ts?from=x HTTP/1.1\r\n\r\n"));
        assertEquals(-1L, request("POST /pause/ab12.ts HTTP/1.1\r\n\r\n"));
        assertEquals(-1L, request(""));
    }
}
