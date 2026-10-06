package cn.motioncontrol.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

/**
 * The digest of a file listing, computed exactly as the PC computes it
 * (model_share.py / app_update.py): SHA-256 over "path\0size\0sha256\0" per file.
 *
 * <p>The signature only vouches for this digest. Unless the phone recomputes it
 * from the listing it was handed, a valid payload and signature can be lifted
 * from a real release and paired with a different file list.
 */
final class ListingDigest {
    private final MessageDigest summary;

    ListingDigest() {
        try {
            summary = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    ListingDigest add(String path, long size, String sha256) {
        summary.update((path + '\0' + size + '\0' + sha256 + '\0').getBytes(StandardCharsets.UTF_8));
        return this;
    }

    String hex() {
        StringBuilder text = new StringBuilder(64);
        for (byte value : summary.digest()) text.append(String.format(Locale.US, "%02x", value));
        return text.toString();
    }
}
