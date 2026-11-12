package app.tvinto.player;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/**
 * The player counts as the app does: these are what Intl.PluralRules says for
 * each language the app speaks (node, 11 November), so a channel count in the
 * player takes the same form as the same count on the page.
 */
public class PluralFormTest {

    private static final long[] NUMBERS = { 0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 101, 102, 111, 1_000_000 };

    private static final String[][] EXPECTED = {
        { "en", "other one other other other other other other other other other other other other other other" },
        { "de", "other one other other other other other other other other other other other other other other" },
        { "es", "other one other other other other other other other other other other other other other many" },
        { "fr", "one one other other other other other other other other other other other other other many" },
        { "it", "other one other other other other other other other other other other other other other many" },
        { "tr", "other one other other other other other other other other other other other other other other" },
        { "nl", "other one other other other other other other other other other other other other other other" },
        { "hr", "other one few few few other other other other one few other one few other other" },
        { "bs", "other one few few few other other other other one few other one few other other" },
        { "sr", "other one few few few other other other other one few other one few other other" },
        { "sl", "other one two few few other other other other other other other one two other other" },
        { "mk", "other one other other other other other other other one other other one other other other" },
        { "sq", "other one other other other other other other other other other other other other other other" },
        { "pl", "many one few few few many many many many many few many many few many many" },
        { "pt-BR", "one one other other other other other other other other other other other other other many" },
        { "ru", "many one few few few many many many many one few many one few many many" },
    };

    @Test
    public void choosesTheFormIntlWould() {
        for (String[] row : EXPECTED) {
            String[] forms = row[1].split(" ");
            for (int i = 0; i < NUMBERS.length; i++) {
                assertEquals(row[0] + " " + NUMBERS[i], forms[i], PluralForm.of(row[0], NUMBERS[i]));
            }
        }
    }
}
