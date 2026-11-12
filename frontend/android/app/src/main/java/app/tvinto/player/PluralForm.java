package app.tvinto.player;

/**
 * Which form of a counted word a whole number takes, by the language's rules
 * as CLDR states them (and as the app's Intl.PluralRules chooses): "one",
 * "two", "few", "many" or "other". For the languages the app is translated
 * into; any other gets English's one and other.
 *
 * Here rather than android.icu.text.PluralRules so that TextsTest needs no
 * Android, and because only whole numbers are ever counted.
 */
final class PluralForm {

    private PluralForm() {}

    static String of(String language, long n) {
        String code = language == null ? "en" : language.toLowerCase(java.util.Locale.ROOT);
        int dash = code.indexOf('-');
        String base = dash > 0 ? code.substring(0, dash) : code;
        long last = n % 10;
        long lastTwo = n % 100;
        switch (base) {
            case "hr":
            case "bs":
            case "sr":
                if (last == 1 && lastTwo != 11) {
                    return "one";
                }
                return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "few" : "other";
            case "ru":
            case "uk":
                if (last == 1 && lastTwo != 11) {
                    return "one";
                }
                return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "few" : "many";
            case "pl":
                if (n == 1) {
                    return "one";
                }
                return last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? "few" : "many";
            case "sl":
                if (lastTwo == 1) {
                    return "one";
                }
                if (lastTwo == 2) {
                    return "two";
                }
                return lastTwo == 3 || lastTwo == 4 ? "few" : "other";
            case "mk":
                return last == 1 && lastTwo != 11 ? "one" : "other";
            case "fr":
                return n == 0 || n == 1 ? "one" : n != 0 && n % 1_000_000 == 0 ? "many" : "other";
            case "pt":
                return n == 0 || n == 1 ? "one" : n != 0 && n % 1_000_000 == 0 ? "many" : "other";
            case "es":
            case "it":
                return n == 1 ? "one" : n != 0 && n % 1_000_000 == 0 ? "many" : "other";
            default:
                return n == 1 ? "one" : "other";
        }
    }
}
