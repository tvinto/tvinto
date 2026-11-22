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
     * Language codes that name no language a person would choose by: "no
     * linguistic content" (a music-only track), undetermined, several, and
     * uncoded. Spelt out they are noise beside a track's own name, so they
     * read as no language at all -- as on the desktop (desktop-video.service.ts).
     */
    private static final java.util.Set<String> NO_LANGUAGE = new java.util.HashSet<>(java.util.Arrays.asList("zxx", "und", "mul", "mis"));

    /** Whether a language code says no language: empty, or one of NO_LANGUAGE. */
    static boolean saysNoLanguage(String code) {
        return code == null || code.trim().isEmpty() || NO_LANGUAGE.contains(code.trim().toLowerCase(java.util.Locale.ROOT));
    }

    /**
     * The language a track is in, in the app's language (Texts): "Spanish",
     * "Španjolski". '' when the code says none. The desktop names it the same
     * way, so the two players read alike.
     */
    static String languageName(String code) {
        if (saysNoLanguage(code)) {
            return "";
        }
        String lang = code.trim();
        java.util.Locale in = java.util.Locale.forLanguageTag(Texts.language());
        String named = java.util.Locale.forLanguageTag(lang).getDisplayLanguage(in);
        if (named.isEmpty() || named.equalsIgnoreCase(lang)) {
            return lang;
        }
        return named.substring(0, 1).toUpperCase(in) + named.substring(1);
    }

    /**
     * A track's language first, then its own name when that says something
     * more: "English · Surround", "Spanish · Latin American".
     *
     * The own name alone was what the rail showed, and a provider's episodes
     * name their tracks by what they are rather than what language they are
     * in -- "Stereo" and "Surround", "Full" twice -- where TiviMate showed
     * English and English (26 September). A name that already is a
     * language, or says the language, is left as it is. `language` is a name
     * ("English"), not a code: languageName makes one.
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

    /**
     * Every track's label, with the ones that would read the same told apart by
     * number, as the desktop does: two Spanish tracks the file says nothing
     * more about are "Spanish" and "Spanish 2". One that says nothing about
     * itself at all ('') is the list's own word and its place in it, from
     * `unnamedKey` ("track.audioNumber"): "Audio 3", "Subtitles 11".
     */
    static java.util.List<String> toldApart(java.util.List<String> labels, String unnamedKey) {
        java.util.List<Boolean> none = java.util.Collections.nCopies(labels.size(), false);
        return withFlags(labels, none, none, unnamedKey);
    }

    /**
     * toldApart, with what the file's flags say where that tells one track
     * from the rest, in the desktop's words (desktop-video.service.ts,
     * `trackLabels`): "Subtitles 1 · Forced" always, since forced subtitles
     * are only the signs and the foreign lines; "Audio 1 · Default" only when
     * some other track is not the default -- on a lone track, or on all of
     * them, it says nothing. A name that already says "forced" is not told
     * twice.
     */
    static java.util.List<String> withFlags(java.util.List<String> labels, java.util.List<Boolean> forced, java.util.List<Boolean> defaults, String unnamedKey) {
        boolean defaultTells = labels.size() > 1 && defaults.contains(Boolean.FALSE);
        java.util.List<String> out = new java.util.ArrayList<>(labels.size());
        java.util.Map<String, Integer> seen = new java.util.HashMap<>();
        for (int at = 0; at < labels.size(); at++) {
            String label = labels.get(at) == null ? "" : labels.get(at).trim();
            if (label.isEmpty()) {
                label = Texts.t(unnamedKey, at + 1);
            }
            String flag = "";
            if (Boolean.TRUE.equals(forced.get(at))) {
                flag = label.toLowerCase(java.util.Locale.ROOT).contains("forced") ? "" : Texts.t("track.forced");
            } else if (Boolean.TRUE.equals(defaults.get(at)) && defaultTells) {
                flag = Texts.t("track.default");
            }
            if (!flag.isEmpty()) {
                label = label + " · " + flag;
            }
            int count = seen.merge(label, 1, Integer::sum);
            out.add(count == 1 ? label : label + " " + count);
        }
        return out;
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
     * useful part is the name before the brackets, with the bracketed
     * language in front when the name says more. '' when VLC says nothing
     * but a number: toldApart names those.
     */
    static String fromVlc(String name) {
        if (name == null || name.trim().isEmpty()) {
            return "";
        }
        String plain = name.trim();
        String bracketed = "";
        Matcher inBrackets = Pattern.compile("\\[([^\\]]+)\\]").matcher(plain);
        if (inBrackets.find()) {
            bracketed = vlcLanguage(inBrackets.group(1).trim());
        }
        String before = plain.replaceAll("\\s*-?\\s*\\[[^\\]]*\\]", "").trim();
        if (before.isEmpty() || VLC_NUMBERED.matcher(before).matches()) {
            return clean(bracketed);
        }
        return withLanguage(bracketed, before);
    }

    /** VLC's bracketed language: a name it knew ("English"), or the file's code when it did not ("zxx", "spa"). */
    private static String vlcLanguage(String bracketed) {
        if (saysNoLanguage(bracketed) || bracketed.equalsIgnoreCase("No linguistic content")
            || bracketed.equalsIgnoreCase("Undetermined") || bracketed.equalsIgnoreCase("Multiple languages")) {
            return "";
        }
        return bracketed.matches("[A-Za-z]{2,3}") ? languageName(bracketed) : bracketed;
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
