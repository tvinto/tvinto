package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.After;
import org.junit.Test;

public class TextsTest {

    @After
    public void backToEnglish() {
        Texts.use(null);
    }

    @Test
    public void speaksEnglishUnlessToldOtherwise() {
        // An older app sends no language: the player is as it was.
        Texts.use(null);
        assertEquals("Next episode", Texts.t("film.nextEpisode"));
        assertEquals("Audio 3", Texts.t("track.audioNumber", 3));
    }

    @Test
    public void speaksCroatianWhenTheAppDoes() {
        Texts.use("hr");
        assertEquals("Sljedeća epizoda", Texts.t("film.nextEpisode"));
        assertEquals("SLIJEDI 21:00", Texts.t("banner.nextKicker", "21:00"));
    }

    @Test
    public void countsChannelsByEachLanguagesRules() {
        assertEquals("1 channel", Texts.channels(1));
        assertEquals("21 channels", Texts.channels(21));
        Texts.use("hr");
        assertEquals("1 kanal", Texts.channels(1));
        assertEquals("21 kanal", Texts.channels(21));
        assertEquals("11 kanala", Texts.channels(11));
        assertEquals("3 kanala", Texts.channels(3));
        assertEquals("118 kanala", Texts.channels(118));
    }

    @Test
    public void speaksTheWordsTheAppSends() {
        java.util.Map<String, String> german = new java.util.HashMap<>();
        german.put("film.nextEpisode", "Nächste Folge");
        german.put("banner.nextKicker", "DANACH {0}");
        german.put("count.channels.one", "{0} Sender");
        german.put("count.channels.other", "{0} Sender");
        Texts.useWords("de", german);
        assertEquals("Nächste Folge", Texts.t("film.nextEpisode"));
        assertEquals("DANACH 21:00", Texts.t("banner.nextKicker", "21:00"));
        assertEquals("5 Sender", Texts.channels(5));
        // A word the app left out: English, not the key.
        assertEquals("Start over", Texts.t("film.startOver"));

        java.util.Map<String, String> russian = new java.util.HashMap<>();
        russian.put("count.channels.one", "{0} канал");
        russian.put("count.channels.few", "{0} канала");
        russian.put("count.channels.many", "{0} каналов");
        Texts.useWords("ru", russian);
        assertEquals("21 канал", Texts.channels(21));
        assertEquals("3 канала", Texts.channels(3));
        assertEquals("11 каналов", Texts.channels(11));
    }

    @Test
    public void usesNoEmDashes() {
        for (String language : new String[] { null, "hr" }) {
            Texts.use(language);
            for (String key : new String[] { "overlay.turnedAway", "overlay.closingFirst", "film.turnedAway", "film.opening" }) {
                assertFalse(key, Texts.t(key).contains("—"));
            }
        }
    }
}
