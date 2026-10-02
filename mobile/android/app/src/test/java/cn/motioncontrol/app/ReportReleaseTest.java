package cn.motioncontrol.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Test;

public class ReportReleaseTest {
    private static byte[][] reports() {
        return new byte[][]{null, new byte[5], new byte[8], new byte[12]};
    }

    @Test
    public void mouseFailureDoesNotPreventKeyboardOrGamepadRelease() {
        List<Integer> attempted = new ArrayList<>();
        boolean released = ReportRelease.sendAll(reports(), (id, report) -> {
            attempted.add(id);
            if (id == 1) throw new IllegalStateException("bluetooth unavailable");
            return id != 2;
        });
        assertFalse(released);
        assertEquals(Arrays.asList(1, 2, 3), attempted);
    }

    @Test
    public void successRequiresEveryReportToBeAccepted() {
        assertTrue(ReportRelease.sendAll(reports(), (id, report) -> true));
        assertFalse(ReportRelease.sendAll(reports(), (id, report) -> id != 3));
    }
}
