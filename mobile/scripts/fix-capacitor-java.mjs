import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Keep the generated Android projects on the Java 21 LTS baseline used by this
// app. Capacitor CLI may regenerate these files during sync, so normalize them
// after sync instead of allowing an older Java 17 override to return.
const generatedFiles = [
  "android/app/capacitor.build.gradle",
  "android/capacitor-cordova-android-plugins/build.gradle",
];

for (const relativePath of generatedFiles) {
  const path = resolve(relativePath);
  const original = await readFile(path, "utf8");
  const normalized = original.replaceAll("JavaVersion.VERSION_17", "JavaVersion.VERSION_21");
  if (!normalized.includes("JavaVersion.VERSION_21")) {
    throw new Error(`Expected Java 21 compatibility setting was not found in ${relativePath}`);
  }
  if (normalized !== original) {
    await writeFile(path, normalized, "utf8");
    process.stdout.write(`Normalized ${relativePath} to Java 21\n`);
  }
}
