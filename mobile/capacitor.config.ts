import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "cn.motioncontrol.app",
  appName: "MotionControl 手机端",
  webDir: "dist",
  server: {
    androidScheme: "http",
    cleartext: true
  }
};

export default config;

