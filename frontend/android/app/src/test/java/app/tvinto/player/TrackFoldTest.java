package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public class TrackFoldTest {

    @org.junit.After
    public void backToEnglish() {
        Texts.use(null);
    }

    private static FilmPlayback.Track unlabelled(int n, boolean inUse, boolean forced) {
        return new FilmPlayback.Track(FilmPlayback.Track.SUBTITLES, "Subtitles " + n, inUse, n, true, forced);
    }

    private static List<FilmPlayback.Track> subtitles(int count) {
        List<FilmPlayback.Track> out = new ArrayList<>();
        out.add(new FilmPlayback.Track(FilmPlayback.Track.SUBTITLES, "Off", false, null));
        for (int n = 1; n <= count; n++) {
            out.add(unlabelled(n, false, n == 1));
        }
        return out;
    }

    @Test
    public void leavesSixAsTheyAre() {
        List<FilmPlayback.Track> six = subtitles(6);
        assertSame(six, TrackFold.fold(six, false));
    }

    // The Rings of Power S3 E1: 38 subtitle tracks, the first forced.
    @Test
    public void foldsThirtyEightIntoOneRowKeepingOffAndTheForcedOne() {
        List<FilmPlayback.Track> all = subtitles(38);
        all.set(12, unlabelled(12, true, false));
        List<FilmPlayback.Track> folded = TrackFold.fold(all, false);

        assertEquals(4, folded.size());
        assertEquals("Off", folded.get(0).label);
        assertEquals("Subtitles 1", folded.get(1).label);
        assertEquals("Subtitles 12", folded.get(2).label);
        assertEquals(FilmPlayback.Track.FOLD, folded.get(3).kind);
        assertEquals("36 unlabelled tracks", folded.get(3).label);
        assertEquals(FilmPlayback.Track.SUBTITLES, folded.get(3).handle);
    }

    @Test
    public void opensToTheWholeList() {
        List<FilmPlayback.Track> all = subtitles(38);
        assertSame(all, TrackFold.fold(all, true));
    }

    @Test
    public void countsInTheAppsLanguage() {
        Texts.use("hr");
        assertEquals("37 neoznačenih traka", TrackFold.fold(subtitles(38), false).get(2).label);
        assertEquals("22 neoznačene trake", TrackFold.fold(subtitles(23), false).get(2).label);
    }

    @Test
    public void knowsTheFirstTrackTheFoldHolds() {
        List<FilmPlayback.Track> all = subtitles(38);
        assertEquals(2, TrackFold.firstFolded(all));
        assertEquals(null, TrackFold.firstFolded(java.util.Collections.singletonList(unlabelled(1, true, false))));
    }
}
