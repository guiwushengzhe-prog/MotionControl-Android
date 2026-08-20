package cn.motionbridge.camera;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SensorBridgePlugin.class);
        registerPlugin(NativeCameraPlugin.class);
        registerPlugin(NativeAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
