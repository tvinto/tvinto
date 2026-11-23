package app.tvinto.device;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class KeptReportsTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private static byte[] event(int n) {
        return ("{\"event_id\":\"" + n + "\"}").getBytes(StandardCharsets.UTF_8);
    }

    @Test
    public void keepsUntilTakenAndThenNothing() throws Exception {
        KeptReports kept = new KeptReports(new File(temp.getRoot(), "error-reports"));
        kept.keep(event(1));
        kept.keep(event(2));

        List<String> taken = kept.take();
        assertEquals(2, taken.size());
        assertEquals("{\"event_id\":\"1\"}", taken.get(0));
        assertTrue(kept.take().isEmpty());
    }

    @Test
    public void keepsOnlyTheNewestWhenThereAreTooMany() throws Exception {
        KeptReports kept = new KeptReports(temp.getRoot());
        for (int i = 0; i < KeptReports.MOST + 5; i++) {
            kept.keep(event(i));
        }
        List<String> taken = kept.take();
        assertEquals(KeptReports.MOST, taken.size());
        assertEquals("{\"event_id\":\"5\"}", taken.get(0));
    }

    @Test
    public void clearLeavesNothingBehind() throws Exception {
        KeptReports kept = new KeptReports(temp.getRoot());
        kept.keep(event(1));
        new File(temp.getRoot(), "half.part").createNewFile();
        kept.clear();
        assertTrue(kept.take().isEmpty());
        assertEquals(0, temp.getRoot().listFiles().length);
    }
}
