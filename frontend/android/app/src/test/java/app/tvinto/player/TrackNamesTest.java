package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TrackNamesTest {

    // As X-Men's subtitle tracks are named, on the provider, 24 September.
    @Test
    public void dropsTheReleaseGroupsAdvertising() {
        assertEquals("Subtitulos Ingles", TrackNames.clean("Subtitulos Ingles [www.newpct.com][torrent]"));
        assertEquals("Subtitulos Castellano", TrackNames.clean("Subtitulos Castellano [www.newpct.com]"));
        assertEquals("English", TrackNames.clean("English - www.example.com"));
    }

    @Test
    public void keepsWhatAPersonChoosesBy() {
        assertEquals("English (SDH)", TrackNames.clean("English (SDH)"));
        assertEquals("English [Forced]", TrackNames.clean("English [Forced] [www.newpct.com]"));
        assertEquals("Hrvatski", TrackNames.clean("Hrvatski"));
    }

    @Test
    public void keepsTheOriginalWhenNothingWouldBeLeft() {
        assertEquals("[www.newpct.com]", TrackNames.clean("[www.newpct.com]"));
    }

    // Supernatural on the provider, 26 September: TiviMate said English and English.
    @Test
    public void putsTheLanguageFirst() {
        assertEquals("English · Surround", TrackNames.withLanguage("English", "Surround"));
        assertEquals("English · Full", TrackNames.withLanguage("English", "Full"));
        assertEquals("Deutsch · Stereo", TrackNames.withLanguage("Deutsch", "Stereo"));
    }

    @Test
    public void leavesANameThatAlreadySaysTheLanguage() {
        assertEquals("English (SDH)", TrackNames.withLanguage("English", "English (SDH)"));
        assertEquals("Hrvatski", TrackNames.withLanguage("Croatian", "Hrvatski"));
        assertEquals("English", TrackNames.withLanguage("English", ""));
        assertEquals("Surround", TrackNames.withLanguage("", "Surround"));
    }

    @Test
    public void findsTheFilesOwnNameInVlcsDescription() {
        assertEquals("Surround", TrackNames.ownNameFromVlc("Surround - [English]"));
        assertEquals("Full", TrackNames.ownNameFromVlc("Full - [German]"));
        assertEquals(null, TrackNames.ownNameFromVlc("Track 1 - [English]"));
        assertEquals(null, TrackNames.ownNameFromVlc(null));
    }

    @Test
    public void readsVlcsNames() {
        assertEquals("English · Surround", TrackNames.fromVlc("Surround - [English]", 1));
        assertEquals("English", TrackNames.fromVlc("Track 1 - [English]", 1));
        assertEquals("Hrvatski", TrackNames.fromVlc("Hrvatski - [Croatian]", 2));
        assertEquals("Track 3", TrackNames.fromVlc("", 3));
    }

    // Supernatural's two subtitle tracks are both "Full": the language decides.
    @Test
    public void knowsOneLanguageByItsCodes() {
        assertTrue(TrackNames.sameLanguage("en", "en"));
        assertTrue(TrackNames.sameLanguage("eng", "en"));
        assertTrue(TrackNames.sameLanguage("en-US", "EN"));
        assertTrue(TrackNames.sameLanguage("deu", "de"));
    }

    @Test
    public void tellsLanguagesApart() {
        assertFalse(TrackNames.sameLanguage("de", "en"));
        assertFalse(TrackNames.sameLanguage(null, "en"));
        assertFalse(TrackNames.sameLanguage("", ""));
    }
}
