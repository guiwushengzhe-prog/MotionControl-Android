package cn.motionbridge.camera;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Rect;
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
        // ImageReader may expose a crop rectangle that is smaller than the allocated
        // YUV buffers.  MediaPipe must receive that exact crop, not the padded stride
        // area; otherwise the body is stretched or shifted on some Camera2 devices.
        Rect crop = image.getCropRect();
        int left = Math.max(0, crop.left);
        int top = Math.max(0, crop.top);
        int right = Math.min(image.getWidth(), crop.right);
        int bottom = Math.min(image.getHeight(), crop.bottom);
        if (right <= left || bottom <= top) {
            left = 0; top = 0; right = image.getWidth(); bottom = image.getHeight();
        }
        int outputWidth = right - left;
        int outputHeight = bottom - top;
        ensureSize(outputWidth, outputHeight);
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer yBuffer = planes[0].getBuffer(), uBuffer = planes[1].getBuffer(), vBuffer = planes[2].getBuffer();
        int yStart = yBuffer.position(), uStart = uBuffer.position(), vStart = vBuffer.position();
        int yRowStride = planes[0].getRowStride(), yPixelStride = planes[0].getPixelStride();
        int uRowStride = planes[1].getRowStride(), uPixelStride = planes[1].getPixelStride();
        int vRowStride = planes[2].getRowStride(), vPixelStride = planes[2].getPixelStride();
        int output = 0;
        // Y is full resolution; U/V are 2x2 subsampled.  Keep the plane's
        // row/pixel strides instead of assuming tightly packed NV12/NV21 data.
        int chromaLeft = left >> 1;
        int chromaTop = top >> 1;
        for (int row = 0; row < outputHeight; row++) {
            int yRow = yStart + (top + row) * yRowStride + left * yPixelStride;
            int uRow = uStart + (chromaTop + (row >> 1)) * uRowStride + chromaLeft * uPixelStride;
            int vRow = vStart + (chromaTop + (row >> 1)) * vRowStride + chromaLeft * vPixelStride;
            for (int column = 0; column < outputWidth; column++) {
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
        bitmap.setPixels(argb, 0, outputWidth, 0, 0, outputWidth, outputHeight);
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
