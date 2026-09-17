package cn.motioncontrol.app;

import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keystore-backed storage for the device pairing secret.
 *
 * <p>The secret cannot live in WebView localStorage. That is ordinary app
 * storage: readable on a rooted device, included in anything that copies the
 * app's data directory, and not protected by any hardware. The pairing secret
 * is what proves this phone is allowed to send gamepad input to the PC, so it
 * gets the same treatment as a credential.
 *
 * <p>EncryptedSharedPreferences holds the ciphertext; the key that decrypts it
 * lives in the Android Keystore and cannot be exported, so a copy of the
 * preferences file is useless off this device. The manifest also sets
 * allowBackup=false, so none of it reaches a cloud backup.
 *
 * <p>device_id deliberately stays in localStorage. It is an identifier, not a
 * credential -- anyone can invent one, which is exactly why the PC verifies an
 * HMAC over the secret rather than trusting the id.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String FILE_NAME = "motioncontrol_secure";

    private SharedPreferences preferences;

    private SharedPreferences open() throws Exception {
        if (preferences == null) {
            MasterKey masterKey = new MasterKey.Builder(getContext())
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            preferences = EncryptedSharedPreferences.create(
                    getContext(),
                    FILE_NAME,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        }
        return preferences;
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key 与 value 不能为空");
            return;
        }
        try {
            open().edit().putString(key, value).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("安全存储写入失败：" + error.getMessage());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key 不能为空");
            return;
        }
        try {
            JSObject result = new JSObject();
            result.put("value", open().getString(key, null));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("安全存储读取失败：" + error.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("key 不能为空");
            return;
        }
        try {
            open().edit().remove(key).apply();
            call.resolve();
        } catch (Exception error) {
            call.reject("安全存储删除失败：" + error.getMessage());
        }
    }
}
