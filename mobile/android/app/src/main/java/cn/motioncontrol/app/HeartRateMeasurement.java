package cn.motioncontrol.app;

/** 标准蓝牙心率测量（0x2A37）的解析。单独放，好在电脑上测。 */
final class HeartRateMeasurement {
    private HeartRateMeasurement() {}

    /** 第一个字节是标志：最低位 1 表示心率占两个字节。读不出来或者不合理返回 -1。 */
    static int bpm(byte[] value) {
        if (value == null || value.length < 2) return -1;
        boolean wide = (value[0] & 0x01) != 0;
        if (wide && value.length < 3) return -1;
        int bpm = wide ? ((value[1] & 0xff) | ((value[2] & 0xff) << 8)) : (value[1] & 0xff);
        return bpm >= 25 && bpm <= 250 ? bpm : -1;
    }

    /** 标志第 1、2 位是 0b10：支持贴肤检测而且没贴上。没戴好的时候报的数不能信。 */
    static boolean offSkin(byte[] value) {
        return value != null && value.length >= 1 && ((value[0] >> 1) & 0x03) == 0x02;
    }
}
