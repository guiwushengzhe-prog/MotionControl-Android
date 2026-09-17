package cn.motioncontrol.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Brings a directory on this phone into line with one the PC is offering.
 *
 * <p>Two things arrive this way: the Chinese speech model (65 MB, so the app
 * does not have to carry a second copy of what the paired PC already has) and
 * the web bundle (200 KB, so a fix that only touches web code does not need a
 * new APK). Same shape, so one implementation.
 *
 * <p>The PC sends a manifest: every file with its size and digest, plus a
 * digest of the whole listing. That listing digest is what gets written as the
 * completion marker, so the question asked next time is not "do I have
 * something" but "do I have <em>this</em>".
 *
 * <p>Nothing is wiped first. A file already present at the right size with the
 * right digest is skipped, so an interrupted download resumes and a changed
 * bundle fetches only what differs. Files the manifest no longer lists are
 * removed afterwards. The marker is written last: a half-finished directory is
 * never mistaken for a finished one.
 */
public final class ManifestSync {

    /** Reports bytes done out of total, for a progress line. */
    public interface Progress {
        void at(long done, long total);
    }

    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 30000;
    private static final long MANIFEST_LIMIT = 1 << 20;
    public static final String MARKER = ".complete";

    private ManifestSync() {
    }

    public static JSONObject manifest(String baseUrl, String route) throws IOException {
        HttpURLConnection connection = open(baseUrl + route);
        try (InputStream stream = connection.getInputStream()) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int count;
            while ((count = stream.read(chunk)) != -1) {
                buffer.write(chunk, 0, count);
                if (buffer.size() > MANIFEST_LIMIT) throw new IOException("清单异常地大");
            }
            return new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw new IOException("清单读不懂", error);
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Make {@code target} match the manifest. Returns the listing digest.
     *
     * <p>{@code allowedPrefix} is the canonical path the files must stay
     * inside. The manifest came over the network, so a path in it is checked
     * here rather than trusted because the other end "should" be fine.
     */
    public static String sync(JSONObject manifest, File target, String allowedPrefix,
                              String baseUrl, String fileRoute, Progress progress)
            throws IOException {
        JSONArray files = manifest.optJSONArray("files");
        if (files == null || files.length() == 0) throw new IOException("清单是空的");
        long total = Math.max(1L, manifest.optLong("total_bytes", 0L));
        long done = 0L;
        Set<String> wanted = new HashSet<>();

        for (int index = 0; index < files.length(); index++) {
            JSONObject entry = files.optJSONObject(index);
            if (entry == null) throw new IOException("清单有坏条目");
            String relative = entry.optString("path", "").replace('\\', '/');
            String expected = entry.optString("sha256", "");
            long size = entry.optLong("size", -1L);
            if (relative.isEmpty() || expected.isEmpty() || size < 0) {
                throw new IOException("清单有坏条目");
            }
            wanted.add(relative);
            File output = new File(target, relative).getCanonicalFile();
            if (!output.getPath().startsWith(allowedPrefix)) {
                throw new IOException("清单里的路径无效：" + relative);
            }
            if (output.isFile() && output.length() == size && expected.equalsIgnoreCase(digestOf(output))) {
                done += size;
                if (progress != null) progress.at(done, total);
                continue;
            }
            File parent = output.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("无法创建目录 " + relative);
            }
            String actual = fetchTo(baseUrl + fileRoute + URLEncoder.encode(relative, "UTF-8"), output);
            if (!expected.equalsIgnoreCase(actual)) {
                // 校验不过就删掉，否则下次"续传"会把这个坏文件当成下好的跳过去。
                output.delete();
                throw new IOException("文件校验不过：" + relative);
            }
            done += size;
            if (progress != null) progress.at(done, total);
        }
        prune(target, target, wanted);
        return manifest.optString("digest", "");
    }

    /** 删掉清单里没有的文件：换了一版之后上一版的残留会留在这里。 */
    private static void prune(File root, File directory, Set<String> wanted) {
        File[] entries = directory.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            if (entry.isDirectory()) {
                prune(root, entry, wanted);
                entry.delete();   // 空了才删得掉，非空时这一步无害地失败
                continue;
            }
            String relative = entry.getAbsolutePath()
                    .substring(root.getAbsolutePath().length() + 1)
                    .replace(File.separatorChar, '/');
            if (!relative.equals(MARKER) && !relative.equals(BundleSignature.ISSUED_MARKER)
                    && !wanted.contains(relative)) {
                entry.delete();
            }
        }
    }

    public static String readMarker(File directory) {
        return readText(new File(directory, MARKER));
    }

    public static void writeMarker(File directory, String digest) throws IOException {
        writeText(new File(directory, MARKER), digest);
    }

    static String readText(File file) {
        if (!file.isFile() || file.length() > 256) return "";
        try (FileInputStream stream = new FileInputStream(file)) {
            byte[] buffer = new byte[(int) file.length()];
            int read = stream.read(buffer);
            return read <= 0 ? "" : new String(buffer, 0, read, StandardCharsets.UTF_8).trim();
        } catch (IOException error) {
            return "";
        }
    }

    static void writeText(File file, String value) throws IOException {
        try (FileOutputStream stream = new FileOutputStream(file)) {
            stream.write(value.getBytes(StandardCharsets.UTF_8));
        }
    }

    public static void clearMarker(File directory) {
        new File(directory, MARKER).delete();
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        int status = connection.getResponseCode();
        if (status != 200) {
            connection.disconnect();
            throw new IOException("电脑没有给出这个文件（HTTP " + status + "）");
        }
        return connection;
    }

    /** Stream a file to disk, returning what it actually hashed to. */
    private static String fetchTo(String url, File output) throws IOException {
        HttpURLConnection connection = open(url);
        try (InputStream stream = connection.getInputStream();
             FileOutputStream file = new FileOutputStream(output)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] chunk = new byte[65536];
            int count;
            while ((count = stream.read(chunk)) != -1) {
                file.write(chunk, 0, count);
                digest.update(chunk, 0, count);
            }
            return hex(digest.digest());
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw new IOException("下载失败", error);
        } finally {
            connection.disconnect();
        }
    }

    public static String digestOf(File file) throws IOException {
        try (FileInputStream stream = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] chunk = new byte[65536];
            int count;
            while ((count = stream.read(chunk)) != -1) digest.update(chunk, 0, count);
            return hex(digest.digest());
        } catch (IOException error) {
            throw error;
        } catch (Exception error) {
            throw new IOException("无法校验已有文件", error);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder text = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) text.append(String.format(Locale.US, "%02x", value));
        return text.toString();
    }
}
