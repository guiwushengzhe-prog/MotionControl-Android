import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// CLI 7 is kept for its patched archive dependencies, while the runtime stays
// on Capacitor 6 so this project can build with the installed Java 17 toolchain.
// CLI 7 emits Java 21 into two generated Gradle files; normalize them after sync.
const generatedFiles = [
  "android/app/capacitor.build.gradle",
  "android/capacitor-cordova-android-plugins/build.gradle",
];

for (const relativePath of generatedFiles) {
  const path = resolve(relativePath);
  const original = await readFile(path, "utf8");
  const normalized = original.replaceAll("JavaVersion.VERSION_21", "JavaVersion.VERSION_17");
  if (!normalized.includes("JavaVersion.VERSION_17")) {
    throw new Error(`Expected Java compatibility setting was not found in ${relativePath}`);
  }
  if (normalized !== original) {
    await writeFile(path, normalized, "utf8");
    process.stdout.write(`Normalized ${relativePath} to Java 17\n`);
  }
}

