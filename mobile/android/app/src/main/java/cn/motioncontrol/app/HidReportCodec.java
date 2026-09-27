package cn.motioncontrol.app;

/** 蓝牙组合输入设备的报告描述和编码；报告内容不包含编号字节。 */
final class HidReportCodec {
    static final int MOUSE_ID = 1;
    static final int KEYBOARD_ID = 2;
    static final int GAMEPAD_ID = 3;

    private HidReportCodec() {}

    static byte[] descriptor() {
        return bytes(
                // 鼠标：三个按钮、两个有符号 16 位相对坐标。
                0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x85, MOUSE_ID,
                0x09, 0x01, 0xa1, 0x00, 0x05, 0x09, 0x19, 0x01, 0x29, 0x03,
                0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x03, 0x81, 0x02,
                0x75, 0x05, 0x95, 0x01, 0x81, 0x03,
                0x05, 0x01, 0x09, 0x30, 0x09, 0x31,
                0x16, 0x01, 0x80, 0x26, 0xff, 0x7f, 0x75, 0x10, 0x95, 0x02,
                0x81, 0x06, 0xc0, 0xc0,
                // 键盘：八个修饰键、六个普通键和一个指示灯输出字节。
                0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x85, KEYBOARD_ID,
                0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01,
                0x75, 0x01, 0x95, 0x08, 0x81, 0x02,
                0x75, 0x08, 0x95, 0x01, 0x81, 0x03,
                0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x75, 0x01, 0x95, 0x05,
                0x91, 0x02, 0x75, 0x03, 0x95, 0x01, 0x91, 0x03,
                0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x15, 0x00, 0x25, 0x65,
                0x75, 0x08, 0x95, 0x06, 0x81, 0x00, 0xc0,
                // 通用手柄：十六个按钮、左右摇杆的 16 位坐标、两个 8 位扳机。
                0x05, 0x01, 0x09, 0x05, 0xa1, 0x01, 0x85, GAMEPAD_ID,
                0x05, 0x09, 0x19, 0x01, 0x29, 0x10, 0x15, 0x00, 0x25, 0x01,
                0x75, 0x01, 0x95, 0x10, 0x81, 0x02,
                0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x33, 0x09, 0x34,
                0x16, 0x01, 0x80, 0x26, 0xff, 0x7f, 0x75, 0x10, 0x95, 0x04,
                0x81, 0x02, 0x09, 0x32, 0x09, 0x35,
                0x15, 0x00, 0x26, 0xff, 0x00, 0x75, 0x08, 0x95, 0x02,
                0x81, 0x02, 0xc0);
    }

    static byte[] mouse(int buttons, double dx, double dy) {
        byte[] report = new byte[5];
        report[0] = (byte) (buttons & 7);
        putShort(report, 1, relative(dx));
        putShort(report, 3, relative(dy));
        return report;
    }

    static byte[] keyboard(int[] keys) {
        byte[] report = new byte[8];
        boolean[] seen = new boolean[256];
        int count = 0;
        for (int key : keys) {
            if (key < 0 || key > 255 || seen[key]) continue;
            seen[key] = true;
            if (key >= 0xe0 && key <= 0xe7) {
                report[0] |= (byte) (1 << (key - 0xe0));
            } else if (key >= 4 && key <= 0x65) {
                if (count < 6) report[2 + count] = (byte) key;
                count++;
            }
        }
        // 超过六键时使用规范规定的溢出状态，不能悄悄丢掉一个仍按住的键。
        if (count > 6) {
            for (int index = 2; index < report.length; index++) report[index] = 1;
        }
        return report;
    }

    static byte[] gamepad(int buttons, double x, double y, double rx, double ry, double lt, double rt) {
        byte[] report = new byte[12];
        putShort(report, 0, buttons & 0xffff);
        putShort(report, 2, axis(x));
        // 前端屏幕坐标向下为正，通用手柄坐标也保持同一方向。
        putShort(report, 4, axis(y));
        putShort(report, 6, axis(rx));
        putShort(report, 8, axis(ry));
        report[10] = (byte) trigger(lt);
        report[11] = (byte) trigger(rt);
        return report;
    }

    static byte[] neutral(int reportId) {
        switch (reportId) {
            case MOUSE_ID: return mouse(0, 0, 0);
            case KEYBOARD_ID: return keyboard(new int[0]);
            case GAMEPAD_ID: return gamepad(0, 0, 0, 0, 0, 0, 0);
            default: return null;
        }
    }

    private static int relative(double value) {
        return Double.isFinite(value) ? (int) Math.round(Math.max(-32767, Math.min(32767, value))) : 0;
    }

    private static int axis(double value) {
        return Double.isFinite(value) ? relative(Math.max(-1, Math.min(1, value)) * 32767) : 0;
    }

    private static int trigger(double value) {
        return Double.isFinite(value) ? (int) Math.round(Math.max(0, Math.min(1, value)) * 255) : 0;
    }

    private static void putShort(byte[] output, int offset, int value) {
        output[offset] = (byte) value;
        output[offset + 1] = (byte) (value >> 8);
    }

    private static byte[] bytes(int... values) {
        byte[] result = new byte[values.length];
        for (int index = 0; index < values.length; index++) result[index] = (byte) values[index];
        return result;
    }
}
