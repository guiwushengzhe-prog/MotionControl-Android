import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.dirname(mobileRoot);
const distRoot = path.join(mobileRoot, "dist");
const manifestName = "build-provenance.json";

async function filesUnder(root, relative = "") {
  const found = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(root, child));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort();
}

async function fingerprint(root, relative) {
  const content = await readFile(path.join(root, relative));
  return { path: relative, size: content.length, sha256: createHash("sha256").update(content).digest("hex") };
}

const sourceFiles = [];
for (const directory of ["src", "public", "scripts", "config", "fallback"]) {
  for (const relative of await filesUnder(mobileRoot, directory)) {
    sourceFiles.push(await fingerprint(mobileRoot, relative));
  }
}
for (const relative of ["index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "capacitor.config.ts"]) {
  if ((await stat(path.join(mobileRoot, relative))).isFile()) {
    sourceFiles.push(await fingerprint(mobileRoot, relative));
  }
}
sourceFiles.sort((left, right) => left.path.localeCompare(right.path, "en"));
const execute = promisify(execFile);
const git = async (...args) => (await execute("git", ["-C", repositoryRoot, ...args], { encoding: "utf8" })).stdout.trim();
const files = [];
for (const relative of await filesUnder(distRoot)) {
  if (relative !== manifestName && relative !== ".signature") files.push(await fingerprint(distRoot, relative));
}
const manifest = {
  schema: "motioncontrol.build_provenance.v1",
  source: {
    commit: await git("rev-parse", "HEAD"),
    dirty: await git("status", "--porcelain", "--untracked-files=normal", "--", "mobile") !== "",
    files: sourceFiles,
  },
  files,
};
await writeFile(path.join(distRoot, manifestName), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`Build source: ${manifest.source.commit}${manifest.source.dirty ? " (working tree changes)" : ""}\n`);
