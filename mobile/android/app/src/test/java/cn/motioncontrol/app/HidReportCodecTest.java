package cn.motioncontrol.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.util.HashMap;
import java.util.Map;

import org.junit.Test;

public class HidReportCodecTest {
    @Test
    public void descriptorLengthsMatchReports() {
        Map<Integer, Integer> inputBits = new HashMap<>();
        Map<Integer, Integer> outputBits = new HashMap<>();
        byte[] descriptor = HidReportCodec.descriptor();
        int size = 0, count = 0, reportId = 0, collections = 0;
        for (int offset = 0; offset < descriptor.length;) {
            int item = descriptor[offset++] & 255;
            int length = item & 3;
            if (length == 3) length = 4;
            int value = 0;
            for (int byteIndex = 0; byteIndex < length; byteIndex++) {
                value |= (descriptor[offset++] & 255) << (byteIndex * 8);
            }
            switch (item & 0xfc) {
                case 0x74: size = value; break;
                case 0x94: count = value; break;
                case 0x84: reportId = value; break;
                case 0x80: inputBits.merge(reportId, size * count, Integer::sum); break;
                case 0x90: outputBits.merge(reportId, size * count, Integer::sum); break;
                case 0xa0: collections++; break;
                case 0xc0: collections--; break;
                default: break;
            }
        }
        assertEquals(0, collections);
        assertEquals(3, inputBits.size());
        for (int id = 1; id <= 3; id++) {
            assertEquals(HidReportCodec.neutral(id).length * 8, inputBits.get(id).intValue());
        }
        assertEquals(8, outputBits.get(HidReportCodec.KEYBOARD_ID).intValue());
    }

    @Test
    public void mouseKeepsSixteenBitSignedDeltasAndButtonMask() {
        assertArrayEquals(new byte[]{3, (byte) 0x90, 0x01, 0x70, (byte) 0xfe},
                HidReportCodec.mouse(3, 400, -400));
        assertArrayEquals(new byte[]{7, (byte) 0xff, 0x7f, 1, (byte) 0x80},
                HidReportCodec.mouse(255, 999999, -999999));
        assertArrayEquals(new byte[5], HidReportCodec.mouse(0, Double.NaN, Double.POSITIVE_INFINITY));
    }

    @Test
    public void keyboardDeduplicatesMovementKeysAndCanReleaseThem() {
        assertArrayEquals(new byte[]{0, 0, 26, 4, 22, 7, 0, 0},
                HidReportCodec.keyboard(new int[]{26, 4, 22, 7, 26}));
        assertArrayEquals(new byte[]{2, 0, 26, 0, 0, 0, 0, 0},
                HidReportCodec.keyboard(new int[]{0xe1, 26, -1, 256}));
        assertArrayEquals(new byte[8], HidReportCodec.neutral(HidReportCodec.KEYBOARD_ID));
        assertArrayEquals(new byte[]{0, 0, 1, 1, 1, 1, 1, 1},
                HidReportCodec.keyboard(new int[]{4, 5, 6, 7, 8, 9, 10}));
    }

    @Test
    public void gamepadKeepsDownPositiveAndClampsAxesAndTriggers() {
        assertArrayEquals(new byte[]{1, (byte) 0x80, 1, (byte) 0x80, (byte) 0xff, 0x7f,
                        1, (byte) 0xc0, 0, 0x40, (byte) 0x80, (byte) 0xff},
                HidReportCodec.gamepad(0x8001, -2, 2, -0.5, 0.5, 0.5, 2));
        assertArrayEquals(new byte[12], HidReportCodec.gamepad(0, Double.NaN, 0, 0, 0, -1, Double.NaN));
    }
}
