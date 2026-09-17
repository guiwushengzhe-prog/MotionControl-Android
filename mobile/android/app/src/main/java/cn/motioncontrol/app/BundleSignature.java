package cn.motioncontrol.app;

import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;

/**
 * Decides whether a web bundle is allowed to run on this phone.
 *
 * <p>The bundle arrives over the local link and becomes running code. Whoever
 * can put a manifest in front of this phone decides what it executes, and on a
 * LAN that is not only the machine the player meant. "It came from the PC" is
 * an assumption, not an argument.
 *
 * <p>So the link is not trusted. One public key is compiled in here, and only
 * a bundle signed by the matching private key is installed. The private key
 * lives beside the APK signing key, offline, and never enters a repository.
 *
 * <p>An unsigned or wrongly signed bundle is not an error to report and work
 * around -- it is simply not installed, and the phone keeps running the copy
 * inside the APK, which is always good.
 */
public final class BundleSignature {

    /**
     * ECDSA P-256, X.509 SubjectPublicKeyInfo, base64.
     *
     * <p>Replacing this means every phone already installed stops accepting
     * updates until it gets a new APK, so it changes only if the private key
     * is lost or leaked.
     */
    private static final String PUBLIC_KEY =
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE6R7hkxscJdT82U2Nr6A82kXrkC7Hci25"
            + "CGeaCcodPvZLFQFUoBcT+TF+KM+wzYHSSVz21nTu2yymodO98rKu5g==";

    /** 上一次装上的是什么时候签的。旧的东西不许往回装。 */
    static final String ISSUED_MARKER = ".issued";

    private BundleSignature() {
    }

    /**
     * The issue time of a manifest this phone may install, or -1 to refuse.
     *
     * @param installedIssuedAt what the running bundle was signed at, or 0
     */
    public static long accept(JSONObject manifest, String digest, long installedIssuedAt) {
        String payloadText = manifest.optString("payload", "");
        String signatureText = manifest.optString("signature", "");
        if (payloadText.isEmpty() || signatureText.isEmpty() || digest.isEmpty()) {
            return -1;   // 没签名。不报错，就是不装。
        }
        try {
            byte[] payload = Base64.decode(payloadText, Base64.DEFAULT);
            byte[] signature = Base64.decode(signatureText, Base64.DEFAULT);

            Signature verifier = Signature.getInstance("SHA256withECDSA");
            verifier.initVerify(publicKey());
            verifier.update(payload);
            if (!verifier.verify(signature)) {
                return -1;
            }
            // 签名对上了，才轮到看它签的是什么——顺序反过来就等于相信了未验证的内容。
            JSONObject signed = new JSONObject(new String(payload, StandardCharsets.UTF_8));
            if (!digest.equals(signed.optString("digest", ""))) {
                return -1;   // 签的是别的一份包
            }
            long issuedAt = signed.optLong("issued_at", 0L);
            if (issuedAt <= 0L || issuedAt < installedIssuedAt) {
                // 你自己的旧包也是签对的。没有这一条，邻居可以把上个月那版递过来
                // 并且被相信。
                return -1;
            }
            return issuedAt;
        } catch (Exception error) {
            return -1;
        }
    }

    private static PublicKey publicKey() throws Exception {
        byte[] encoded = Base64.decode(PUBLIC_KEY, Base64.DEFAULT);
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(encoded));
    }

    static long readIssued(File directory) {
        try {
            String text = ManifestSync.readText(new File(directory, ISSUED_MARKER));
            return text.isEmpty() ? 0L : Long.parseLong(text.trim());
        } catch (NumberFormatException error) {
            return 0L;
        }
    }

    static void writeIssued(File directory, long issuedAt) throws IOException {
        ManifestSync.writeText(new File(directory, ISSUED_MARKER), Long.toString(issuedAt));
    }
}
