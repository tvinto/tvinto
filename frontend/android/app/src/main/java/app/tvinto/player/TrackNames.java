package app.tvinto.player;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What the audio and subtitles rail calls a track.
 *
 * Track names come from whoever made the file, and a provider's films carry
 * the release group's advertising in them: "Subtitulos Ingles
 * [www.newpct.com][torrent]" on X-Men, 24 September. The rail shows the part
 * a person chose by. Nothing Android in here (TrackNamesTest).
 */
final class TrackNames {

    private static final Pattern BRACKETED = Pattern.compile("\\s*[\\[(][^\\])]*[\\])]");
    private static final Pattern ADDRESS = Pattern.compile("(?i)\\s*(?:https?://\\S+|www\\.\\S+|\\S+\\.(?:com|net|org|to|tv|info|me)\\b\\S*)");
    private static final Pattern VLC_NUMBERED = Pattern.compile("(?i)track\\s*\\d+");

    private TrackNames() {}

    /**
     * A file's own track name without bracketed notes and web addresses.
     * Brackets that say something a person chooses by -- "(SDH)", "(forced)",
     * "[Commentary]" -- stay; the rest go. The original when nothing is left.
     */
    static String clean(String label) {
        if (label == null) {
            return "";
        }
        String original = label.trim();
        StringBuilder kept = new StringBuilder();
        Matcher brackets = BRACKETED.matcher(original);
        int from = 0;
        while (brackets.find()) {
            kept.append(original, from, brackets.start());
            String inside = brackets.group().trim();
            if (isWorthKeeping(inside)) {
                kept.append(' ').append(inside);
            }
            from = brackets.end();
        }
        kept.append(original.substring(from));
        String cleaned = ADDRESS.matcher(kept.toString()).replaceAll("")
            .replaceAll("\\s{2,}", " ")
            .replaceAll("^[\\s\\-|·:]+|[\\s\\-|·:]+$", "")
            .trim();
        return cleaned.isEmpty() ? original : cleaned;
    }

    /**
     * A track's language first, then its own name when that says something
     * more: "English · Surround", "English · Full".
     *
     * The own name alone was what the rail showed, and a provider's episodes
     * name their tracks by what they are rather than what language they are
     * in -- "Stereo" and "Surround", "Full" twice -- where TiviMate showed
     * English and English (26 September). A name that already is a
     * language, or says the language, is left as it is.
     */
    static String withLanguage(String language, String ownName) {
        String name = clean(ownName);
        String lang = language == null ? "" : language.trim();
        if (lang.isEmpty()) {
            return name;
        }
        if (name.isEmpty()) {
            return lang;
        }
        if (name.toLowerCase(java.util.Locale.ROOT).contains(lang.toLowerCase(java.util.Locale.ROOT)) || namesALanguage(name)) {
            return name;
        }
        return lang + " · " + name;
    }

    private static java.util.Set<String> languageNames;

    /** Whether a name is a language's name, in English or in that language: "Croatian", "Hrvatski". */
    private static synchronized boolean namesALanguage(String name) {
        if (languageNames == null) {
            java.util.Set<String> names = new java.util.HashSet<>();
            for (String code : java.util.Locale.getISOLanguages()) {
                java.util.Locale locale = new java.util.Locale(code);
                names.add(locale.getDisplayLanguage(java.util.Locale.ENGLISH).toLowerCase(java.util.Locale.ROOT));
                names.add(locale.getDisplayLanguage(locale).toLowerCase(java.util.Locale.ROOT));
            }
            languageNames = names;
        }
        return languageNames.contains(name.trim().toLowerCase(java.util.Locale.ROOT));
    }

    private static boolean isWorthKeeping(String bracketed) {
        String inside = bracketed.substring(1, bracketed.length() - 1).trim().toLowerCase(java.util.Locale.ROOT);
        return inside.matches("sdh|cc|forced|commentary|signs|songs|signs & songs|hi|descriptive|ad|5\\.1|7\\.1|2\\.0|stereo");
    }

    /**
     * The file's own name for a track, out of VLC's description of it:
     * "Surround" from "Surround - [English]" -- the same thing Media3 calls the
     * track's label, so a choice written down by one player finds its track in
     * the other. Null when VLC only numbered it.
     */
    static String ownNameFromVlc(String name) {
        if (name == null) {
            return null;
        }
        String before = name.trim().replaceAll("\\s*-?\\s*\\[[^\\]]*\\]", "").trim();
        return before.isEmpty() || VLC_NUMBERED.matcher(before).matches() ? null : before;
    }

    /**
     * VLC names tracks "Track 1 - [English]" or "Hrvatski - [Croatian]". The
     * useful part is the name before the brackets, or the bracketed language
     * when the name is only a number.
     */
    static String fromVlc(String name, int number) {
        if (name == null || name.trim().isEmpty()) {
            return Texts.t("track.number", number);
        }
        String plain = name.trim();
        String bracketed = null;
        Matcher inBrackets = Pattern.compile("\\[([^\\]]+)\\]").matcher(plain);
        if (inBrackets.find()) {
            bracketed = inBrackets.group(1).trim();
        }
        String before = plain.replaceAll("\\s*-?\\s*\\[[^\\]]*\\]", "").trim();
        if (before.isEmpty() || VLC_NUMBERED.matcher(before).matches()) {
            return bracketed != null && !bracketed.isEmpty() ? clean(bracketed) : Texts.t("track.number", number);
        }
        return withLanguage(bracketed, before);
    }

    /**
     * Whether two language codes name one language: "en", "eng" and "en-US"
     * do. A player normalises some files' codes and not others, and a choice
     * remembered from one episode is compared with the next episode's tracks.
     */
    static boolean sameLanguage(String a, String b) {
        if (a == null || b == null || a.trim().isEmpty() || b.trim().isEmpty()) {
            return false;
        }
        String left = a.trim().toLowerCase(java.util.Locale.ROOT).split("[-_]")[0];
        String right = b.trim().toLowerCase(java.util.Locale.ROOT).split("[-_]")[0];
        if (left.equals(right)) {
            return true;
        }
        try {
            return new java.util.Locale(left).getISO3Language().equals(new java.util.Locale(right).getISO3Language());
        } catch (java.util.MissingResourceException ignored) {
            return false;
        }
    }
}
