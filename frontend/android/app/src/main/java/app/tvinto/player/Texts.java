package app.tvinto.player;

import java.util.HashMap;
import java.util.Map;

/**
 * The player's words: those the app sends in its language (EXTRA_TEXTS),
 * else built-in English or Croatian (26 September).
 *
 * The app says which with every film or channel it opens (EXTRA_LANGUAGE); an
 * older app says nothing and gets English, as before. Android's own resources
 * would follow the device's language, and the language here is the one chosen
 * in the app, which need not be the same.
 *
 * `{0}`, `{1}` in a text are filled in order. Nothing Android in here
 * (TextsTest).
 */
final class Texts {

    private static volatile boolean croatian = false;

    private static final Map<String, String[]> WORDS = new HashMap<>();

    private static void word(String key, String english, String croatianText) {
        WORDS.put(key, new String[] { english, croatianText });
    }

    static {
        word("banner.guide", "Guide", "Vodič");
        word("banner.noGuide", "No programme guide for this channel", "Za ovaj kanal nema TV vodiča");
        word("banner.noDescription", "The guide has no description for this programme.", "Vodič nema opis ove emisije.");
        word("banner.nextKicker", "NEXT {0}", "SLIJEDI {0}");
        word("directory.noGuide", "No guide", "Nema vodiča");
        word("directory.left", "{0} · {1} min left", "{0} · još {1} min");
        word("directory.next", "Next {0}", "Slijedi {0}");
        word("overlay.tryingAgain", "TRYING AGAIN", "PONOVNI POKUŠAJ");
        word("overlay.changingTo", "CHANGING TO", "PREBACUJEM NA");
        word("overlay.attempt", "attempt 2 of 2", "pokušaj 2 od 2");
        word("overlay.from", "from {0}", "s {0}");
        word("overlay.turnedAway", "The provider turned the first attempt away, usually because the old stream had not closed yet.", "Pružatelj je odbio prvi pokušaj, obično jer se stari stream još nije zatvorio.");
        word("overlay.closingFirst", "Closing the old stream first. Only one can play at a time", "Najprije zatvaram stari stream. Istodobno može raditi samo jedan");
        word("overlay.couldNotStart", "Could not start this channel", "Nije moguće pokrenuti ovaj kanal");
        word("overlay.backReturns", "Back returns to {0}", "Natrag vraća na {0}");
        word("mini.playingNow", "Playing now", "Upravo gledate");
        word("number.noChannel", "No channel {0}", "Nema kanala {0}");
        word("number.noNumbers", "No channel here has a number", "Nijedan kanal ovdje nema broj");
        word("number.range", "Numbers here run {0}", "Brojevi ovdje idu {0}");
        word("number.notYet", "No channel {0} yet", "Još nema kanala {0}");
        word("film.opening", "Opening… your provider allows one stream at a time", "Otvaram… pružatelj dopušta jedan stream istodobno");
        word("film.paused", "PAUSED", "PAUZIRANO");
        word("film.tracks", "Audio, subtitles & picture", "Zvuk, titlovi i slika");
        word("film.startOver", "Start over", "Ispočetka");
        word("film.nextEpisode", "Next episode", "Sljedeća epizoda");
        word("film.skipIntro", "Skip intro", "Preskoči uvod");
        word("film.skipRecap", "Skip recap", "Preskoči sažetak");
        word("film.episodes", "Episodes", "Epizode");
        word("film.youreWatching", "YOU'RE WATCHING", "GLEDATE");
        word("film.pausedAt", "paused at {0}", "pauzirano na {0}");
        word("film.watching", "Watching", "Gledate");
        word("film.speed", "Speed", "Brzina");
        word("film.speedNow", "Speed {0}", "Brzina {0}");
        word("film.speedTitle", "PLAYBACK SPEED", "BRZINA REPRODUKCIJE");
        word("film.normal", "{0} (normal)", "{0} (normalno)");
        word("film.audioTitle", "Audio", "Zvuk");
        word("film.subtitlesTitle", "Subtitles", "Titlovi");
        word("film.pictureLine", "Picture", "Slika");
        word("film.timingLine", "Subtitle timing", "Vrijeme titlova");
        word("film.audioSubtitles", "Audio & subtitles", "Zvuk i titlovi");
        word("film.nextShort", "NEXT", "SLJEDEĆA");
        word("film.backCancels", "Back cancels", "Natrag poništava");
        word("film.resumingAt", "Resuming at {0}", "Nastavljam od {0}");
        word("film.playNow", "Play now", "Pusti odmah");
        word("film.cancel", "Cancel", "Odustani");
        word("film.nextIn", "NEXT EPISODE IN", "SLJEDEĆA EPIZODA ZA");
        word("film.lastEpisode", "That was the last episode", "To je bila zadnja epizoda");
        word("film.backToShow", "Back to the show", "Natrag na seriju");
        word("film.watchCredits", "Watch the credits", "Gledaj odjavnu špicu");
        word("film.play", "Play", "Pusti");
        word("film.pause", "Pause", "Pauza");
        word("film.turnedAway", "Your provider turned it away. Trying once more", "Pružatelj je odbio. Pokušavam još jednom");
        word("film.ends", "ends ", "završava ");
        word("film.from", "from ", "od ");
        word("film.audio", "Audio {0}", "Zvuk {0}");
        word("film.subtitles", "Subtitles {0}", "Titlovi {0}");
        word("film.rememberedShow", "Remembered for this show", "Zapamćeno za ovu seriju");
        word("film.rememberedFilm", "Remembered for this film", "Zapamćeno za ovaj film");
        word("film.audioGroup", "AUDIO", "ZVUK");
        word("film.subtitlesGroup", "SUBTITLES", "TITLOVI");
        word("film.pictureGroup", "PICTURE", "SLIKA");
        word("picture.original", "Original", "Izvorno");
        word("picture.fill", "Fill screen", "Ispuni zaslon");
        word("picture.stretch", "Stretch", "Rastegni");
        word("film.subtitleTiming", "Timing {0} s", "Pomak {0} s");
        word("film.earlier", "Earlier", "Ranije");
        word("film.later", "Later", "Kasnije");
        word("film.noSubtitlesEpisode", "This episode has no subtitles", "Ova epizoda nema titlove");
        word("film.noSubtitlesFilm", "This film has no subtitles", "Ovaj film nema titlove");
        word("live.noSubtitles", "This channel has no subtitles", "Ovaj kanal nema titlove");
        word("live.behind", "{0} behind live", "{0} iza prijenosa uživo");
        word("live.backToLive", "Back to live", "Natrag na uživo");
        word("live.cannotPause", "This channel can't be paused", "Ovaj kanal se ne može pauzirati");
        word("sleep.title", "Sleep timer", "Automatsko gašenje");
        word("sleep.off", "Off", "Isključeno");
        word("sleep.minutes", "{0} minutes", "{0} minuta");
        word("sleep.programmeEnd", "End of this programme · {0}", "Kraj ove emisije · {0}");
        word("sleep.filmEnd", "End of this film", "Kraj ovog filma");
        word("sleep.episodeEnd", "End of this episode", "Kraj ove epizode");
        word("sleep.left", "{0} min left", "još {0} min");
        word("sleep.untilEnd", "Until the end", "Do kraja");
        word("sleep.stoppingIn", "Stopping in {0}", "Zaustavljam za {0}");
        word("sleep.keepWatching", "Keep watching", "Nastavi gledati");
        word("sleep.stopNow", "Stop now", "Zaustavi odmah");
        word("track.off", "Off", "Isključeno");
        word("track.audioNumber", "Audio {0}", "Zvuk {0}");
        word("track.subtitlesNumber", "Subtitles {0}", "Titlovi {0}");
        word("track.inUse", "in use", "u upotrebi");
        word("seek.minSteps", "{0} min steps", "koraci od {0} min");
        word("seek.secondSteps", "{0} s steps", "koraci od {0} s");
        word("length.minutes", "{0} min", "{0} min");
        word("length.hours", "{0} h {1} min", "{0} h {1} min");
    }

    private Texts() {}

    /** The words the app sent for its language (`use`), by the same keys; empty from an older app. */
    private static volatile Map<String, String> given = new HashMap<>();
    /** The language they are in, for counting ("1 kanal", "3 kanala"). */
    private static volatile String language = "en";

    /** From the app's EXTRA_LANGUAGE: "hr" for Croatian, anything else English. */
    static void use(String language) {
        useWords(language, null);
    }

    /**
     * The app's language and, from an app that sends them (EXTRA_TEXTS), its
     * words for the player, flat by key ("film.nextEpisode", and "count.channels.few"
     * for each form of a count). What it leaves out is said in the built-in
     * English or Croatian, as an older app gets.
     */
    static void use(String language, String textsJson) {
        Map<String, String> read = new HashMap<>();
        if (textsJson != null && !textsJson.isEmpty()) {
            try {
                org.json.JSONObject all = new org.json.JSONObject(textsJson);
                java.util.Iterator<String> keys = all.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    Object value = all.opt(key);
                    if (value instanceof String) {
                        read.put(key, (String) value);
                    }
                }
            } catch (org.json.JSONException broken) {
                // The built-in words, then.
            }
        }
        useWords(language, read);
    }

    /** The same, with the words already read: what the tests use, having no org.json. */
    static void useWords(String language, Map<String, String> words) {
        croatian = "hr".equals(language);
        Texts.language = language == null || language.isEmpty() ? "en" : language;
        given = words == null ? new HashMap<>() : new HashMap<>(words);
    }

    /** The app's language, "en" when it said none: what track languages are named in (TrackNames). */
    static String language() {
        return language;
    }

    static boolean isCroatian() {
        return croatian;
    }

    static String t(String key, Object... values) {
        String text = given.get(key);
        if (text == null) {
            String[] pair = WORDS.get(key);
            text = pair == null ? key : pair[croatian ? 1 : 0];
        }
        for (int i = 0; i < values.length; i++) {
            text = text.replace("{" + i + "}", String.valueOf(values[i]));
        }
        return text;
    }

    /** "1 channel", "5 channels"; in Croatian one, few or many: "1 kanal", "3 kanala", "5 kanala". */
    static String channels(int count) {
        String form = given.get("count.channels." + PluralForm.of(language, count));
        if (form == null) {
            form = given.get("count.channels.other");
        }
        if (form != null) {
            return form.replace("{0}", String.valueOf(count));
        }
        if (!croatian) {
            return count + (count == 1 ? " channel" : " channels");
        }
        int lastTwo = count % 100;
        int last = count % 10;
        if (last == 1 && lastTwo != 11) {
            return count + " kanal";
        }
        return count + " kanala";
    }
}
