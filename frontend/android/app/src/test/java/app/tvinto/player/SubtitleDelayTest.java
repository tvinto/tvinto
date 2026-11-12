package app.tvinto.player;

import static org.junit.Assert.assertEquals;

import org.junit.After;
import org.junit.Test;

public class SubtitleDelayTest {

    @After
    public void reset() {
        Texts.use(null);
    }

    @Test
    public void saysTheTimingInTenthsWithTheWayItGoes() {
        assertEquals("Timing 0.0 s", SubtitleDelay.label(0L));
        assertEquals("Timing +0.5 s", SubtitleDelay.label(500L));
        assertEquals("Timing −1.2 s", SubtitleDelay.label(-1200L));
        Texts.use("hr");
        assertEquals("Pomak +0.1 s", SubtitleDelay.label(100L));
    }

    @Test
    public void givesTheAmountAloneWhereTheLineSaysWhatItIs() {
        assertEquals("0.0", SubtitleDelay.amount(0L));
        assertEquals("+0.5", SubtitleDelay.amount(500L));
        assertEquals("−1.2", SubtitleDelay.amount(-1200L));
    }

    @Test
    public void stopsHalfAMinuteEitherWay() {
        assertEquals(30_000L, SubtitleDelay.clamp(45_000L));
        assertEquals(-30_000L, SubtitleDelay.clamp(-30_100L));
        assertEquals(-200L, SubtitleDelay.clamp(-200L));
    }

    @Test
    public void theShiftKeepsWhatItWasGivenWithinTheLimit() {
        SubtitleDelay.Shift shift = new SubtitleDelay.Shift();
        shift.setMs(-700L);
        assertEquals(-700L, shift.ms());
        assertEquals(-700_000L, shift.micros());
        shift.setMs(90_000L);
        assertEquals(30_000L, shift.ms());
    }
}
