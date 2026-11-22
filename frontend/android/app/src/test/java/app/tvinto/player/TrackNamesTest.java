package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class TrackNamesTest {

    @org.junit.After
    public void backToEnglish() {
        Texts.use(null);
    }

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
        assertEquals("English · Surround", TrackNames.fromVlc("Surround - [English]"));
        assertEquals("English", TrackNames.fromVlc("Track 1 - [English]"));
        assertEquals("Hrvatski", TrackNames.fromVlc("Hrvatski - [Croatian]"));
        assertEquals("", TrackNames.fromVlc(""));
    }

    @Test
    public void readsVlcsCodesAndItsNoLanguage() {
        assertEquals("Spanish", TrackNames.fromVlc("Track 2 - [spa]"));
        assertEquals("Composer's Isolated Score", TrackNames.fromVlc("Composer's Isolated Score - [zxx]"));
        assertEquals("", TrackNames.fromVlc("Track 3 - [und]"));
    }

    // As the desktop does (desktop-video.service.ts, 14 November).
    @Test
    public void namesNoLanguageForTheSpecialCodes() {
        for (String code : new String[] { "zxx", "und", "mul", "mis", "ZXX", "", null }) {
            assertEquals("", TrackNames.languageName(code));
        }
        assertEquals("Composer's Isolated Score", TrackNames.withLanguage(TrackNames.languageName("zxx"), "Composer's Isolated Score"));
    }

    @Test
    public void namesTheLanguageInTheAppsLanguage() {
        assertEquals("Spanish", TrackNames.languageName("spa"));
        assertEquals("Spanish", TrackNames.languageName("es"));
        Texts.use("hr");
        assertEquals("Španjolski", TrackNames.languageName("es"));
    }

    @Test
    public void keepsATitleThatSaysWhichOne() {
        assertEquals("Spanish · Latin American", TrackNames.withLanguage("Spanish", "Latin American"));
        assertEquals("Spanish · Castilian", TrackNames.withLanguage("Spanish", "Castilian"));
        assertEquals("Chinese · Simplified", TrackNames.withLanguage("Chinese", "Simplified"));
        assertEquals("English · Commentary", TrackNames.withLanguage("English", "Commentary"));
    }

    @Test
    public void numbersRepeatsAndTracksThatSayNothing() {
        assertEquals(
            java.util.Arrays.asList("Spanish", "Spanish · Latin American", "Spanish 2", "English", "Subtitles 5", "Spanish 3"),
            TrackNames.toldApart(java.util.Arrays.asList("Spanish", "Spanish · Latin American", "Spanish", "English", "", "Spanish"), "track.subtitlesNumber"));
        assertEquals(java.util.Arrays.asList("Audio 1", "Audio 2"), TrackNames.toldApart(java.util.Arrays.asList("", null), "track.audioNumber"));
    }

    @Test
    public void numbersInTheAppsLanguage() {
        Texts.use("hr");
        assertEquals(java.util.Arrays.asList("Titlovi 1"), TrackNames.toldApart(java.util.Arrays.asList(""), "track.subtitlesNumber"));
    }

    // The Rings of Power S3 E1, 22 November: 38 subtitle tracks saying nothing, the first forced and default.
    @Test
    public void saysAForcedTrackAndADefaultOnlyWhereItTellsSomething() {
        java.util.List<String> none = java.util.Arrays.asList("", "", "");
        assertEquals(
            java.util.Arrays.asList("Subtitles 1 · Forced", "Subtitles 2", "Subtitles 3"),
            TrackNames.withFlags(none, java.util.Arrays.asList(true, false, false), java.util.Arrays.asList(true, false, false), "track.subtitlesNumber"));
        assertEquals(java.util.Arrays.asList("Audio 1"), TrackNames.withFlags(java.util.Arrays.asList(""), java.util.Arrays.asList(false), java.util.Arrays.asList(true), "track.audioNumber"));
        assertEquals(
            java.util.Arrays.asList("Audio 1 · Default", "English"),
            TrackNames.withFlags(java.util.Arrays.asList("", "English"), java.util.Arrays.asList(false, false), java.util.Arrays.asList(true, false), "track.audioNumber"));
        assertEquals(
            java.util.Arrays.asList("English (forced)", "English"),
            TrackNames.withFlags(java.util.Arrays.asList("English (forced)", "English"), java.util.Arrays.asList(true, false), java.util.Arrays.asList(false, false), "track.subtitlesNumber"));
    }

    @Test
    public void saysTheFlagsInTheAppsLanguage() {
        Texts.use("hr");
        assertEquals(
            java.util.Arrays.asList("Titlovi 1 · Prisilni", "Titlovi 2"),
            TrackNames.withFlags(java.util.Arrays.asList("", ""), java.util.Arrays.asList(true, false), java.util.Arrays.asList(false, false), "track.subtitlesNumber"));
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
