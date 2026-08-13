package cn.motionbridge.camera;

import android.content.Context;
import android.graphics.Bitmap;
import android.media.Image;

import java.nio.ByteBuffer;

/** Reuses Bitmap/int buffers; no JPEG/Base64/JS transfer and no vendor RenderScript dependency. */
final class YuvToRgbConverter implements AutoCloseable {
    private Bitmap bitmap;
    private int[] argb;
    private int width;
    private int height;

    YuvToRgbConverter(Context context) { }

    Bitmap convert(Image image) {
        ensureSize(image.getWidth(), image.getHeight());
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer yBuffer = planes[0].getBuffer(), uBuffer = planes[1].getBuffer(), vBuffer = planes[2].getBuffer();
        int yStart = yBuffer.position(), uStart = uBuffer.position(), vStart = vBuffer.position();
        int yRowStride = planes[0].getRowStride(), yPixelStride = planes[0].getPixelStride();
        int uRowStride = planes[1].getRowStride(), uPixelStride = planes[1].getPixelStride();
        int vRowStride = planes[2].getRowStride(), vPixelStride = planes[2].getPixelStride();
        int output = 0;
        for (int row = 0; row < height; row++) {
            int yRow = yStart + row * yRowStride;
            int uRow = uStart + (row >> 1) * uRowStride;
            int vRow = vStart + (row >> 1) * vRowStride;
            for (int column = 0; column < width; column++) {
                int y = (yBuffer.get(yRow + column * yPixelStride) & 0xff) - 16;
                int u = (uBuffer.get(uRow + (column >> 1) * uPixelStride) & 0xff) - 128;
                int v = (vBuffer.get(vRow + (column >> 1) * vPixelStride) & 0xff) - 128;
                if (y < 0) y = 0;
                int base = 298 * y;
                int red = (base + 409 * v + 128) >> 8;
                int green = (base - 100 * u - 208 * v + 128) >> 8;
                int blue = (base + 516 * u + 128) >> 8;
                argb[output++] = 0xff000000 | (clamp(red) << 16) | (clamp(green) << 8) | clamp(blue);
            }
        }
        bitmap.setPixels(argb, 0, width, 0, 0, width, height);
        return bitmap;
    }

    private void ensureSize(int nextWidth, int nextHeight) {
        if (bitmap != null && width == nextWidth && height == nextHeight) return;
        if (bitmap != null) bitmap.recycle();
        width = nextWidth; height = nextHeight; argb = new int[width * height];
        bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
    }

    private static int clamp(int value) { return value < 0 ? 0 : Math.min(value, 255); }

    @Override public void close() {
        if (bitmap != null) bitmap.recycle(); bitmap = null; argb = null;
    }
}
