package cn.motioncontrol.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SensorBridgePlugin.class);
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(NativeAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
