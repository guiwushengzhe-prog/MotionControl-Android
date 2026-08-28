import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "cn.motionbridge.camera",
  appName: "MotionControl 手机端",
  webDir: "dist",
  server: {
    androidScheme: "http",
    cleartext: true
  }
};

export default config;

