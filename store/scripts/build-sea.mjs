#!/usr/bin/env node
/**
 * store/scripts/build-sea.mjs — Build the token-tally SEA binary.
 *
 * Outputs (all under store/dist/sea/):
 *   token-tally          — self-contained executable (Node binary + CLI bundle)
 *   better_sqlite3.node  — native SQLite addon (must be distributed alongside
 *                          the binary in the same directory)
 *
 * Why the addon can't be embedded:
 *   Native .node addons must be dlopen()d from the filesystem; they cannot be
 *   stored inside the SEA blob. Place both files in the same directory when
 *   distributing or installing.
 *
 * The bindings shim:
 *   better-sqlite3 uses the `bindings` package to locate better_sqlite3.node
 *   relative to its own node_modules tree. That tree doesn't exist on target
 *   machines. The esbuild plugin below replaces `bindings` with a shim that
 *   loads the addon from path.dirname(process.execPath) instead.
 */

import { build } from "esbuild";
import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, chmodSync } from "fs";
import { createRequire } from "module";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storeDir = join(__dirname, "..");
const workspaceRoot = join(storeDir, "..");
const outDir = join(storeDir, "dist", "sea");
const require = createRequire(import.meta.url);

const bundlePath = join(outDir, "sea-bundle.js");
const blobPath = join(outDir, "sea-prep.blob");
const binaryPath = join(outDir, "token-tally");
const postjectBin = join(storeDir, "node_modules", ".bin", "postject");

mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Bundle CLI with esbuild
// ---------------------------------------------------------------------------
console.log("Bundling CLI…");
await build({
  entryPoints: [join(storeDir, "sea-entry.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath,
  // Suppress noisy dynamic-require warnings for paths that are intentionally
  // resolved at runtime (e.g. yargs locale files).
  logOverride: { "unsupported-dynamic-import": "silent" },
  // Substitute import.meta.url at the source level so that modules compiled
  // as CJS (where esbuild doesn't auto-inject the URL shim) still get a
  // valid URL.  In a SEA binary __filename is process.execPath.
  // esbuild define only accepts identifiers/literals, so we inject the
  // runtime value via a banner variable and point define at it.
  banner: {
    js: "var __import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "__import_meta_url",
  },
  plugins: [
    {
      name: "bindings-shim",
      setup(build) {
        // Replace the `bindings` package with a shim that loads the native
        // addon from the directory containing the SEA executable, so the
        // addon can be distributed alongside the binary instead of inside a
        // node_modules tree.
        build.onResolve({ filter: /^bindings$/ }, () => ({
          path: "bindings",
          namespace: "bindings-shim",
        }));
        build.onLoad({ filter: /.*/, namespace: "bindings-shim" }, () => ({
          contents: `
const path = require('path');
module.exports = function bindings(name) {
  const filename = name.endsWith('.node') ? name : name + '.node';
  const addonPath = path.join(path.dirname(process.execPath), filename);
  // In a SEA binary, require() is restricted to built-in modules and cannot
  // load filesystem paths. Use process.dlopen() to bypass the module system
  // and load the native addon directly via the OS dynamic linker.
  const binding = { exports: {} };
  process.dlopen(binding, addonPath);
  return binding.exports;
};
          `.trim(),
          loader: "js",
        }));
      },
    },
  ],
});
console.log("  →", bundlePath);

// ---------------------------------------------------------------------------
// 2. Generate SEA blob
// ---------------------------------------------------------------------------
console.log("Generating SEA blob…");
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], {
  cwd: storeDir,
  stdio: "inherit",
});
console.log("  →", blobPath);

// ---------------------------------------------------------------------------
// 3. Copy the running Node binary as the base executable
// ---------------------------------------------------------------------------
console.log("Copying Node binary…");
copyFileSync(process.execPath, binaryPath);
chmodSync(binaryPath, 0o755);

// ---------------------------------------------------------------------------
// 4. Remove existing code signature (required on macOS before re-injection)
// ---------------------------------------------------------------------------
if (process.platform === "darwin") {
  console.log("Removing codesign signature…");
  execFileSync("codesign", ["--remove-signature", binaryPath], {
    stdio: "inherit",
  });
}

// ---------------------------------------------------------------------------
// 5. Inject the SEA blob into the binary
// ---------------------------------------------------------------------------
console.log("Injecting SEA blob…");
const postjectArgs = [
  binaryPath,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
execFileSync(postjectBin, postjectArgs, { stdio: "inherit" });

// ---------------------------------------------------------------------------
// 6. Re-sign the binary (macOS requires a valid signature to run)
// ---------------------------------------------------------------------------
if (process.platform === "darwin") {
  console.log("Re-signing binary…");
  execFileSync("codesign", ["--sign", "-", binaryPath], { stdio: "inherit" });
}

// ---------------------------------------------------------------------------
// 7. Copy the native addon alongside the binary
// ---------------------------------------------------------------------------
console.log("Copying native addon…");
const addonSrc = require.resolve(
  "better-sqlite3/build/Release/better_sqlite3.node",
  { paths: [storeDir] },
);
const addonDst = join(outDir, "better_sqlite3.node");
copyFileSync(addonSrc, addonDst);
console.log("  →", addonDst);

console.log("\nDone. SEA outputs:");
console.log("  binary:", binaryPath);
console.log("  addon: ", addonDst);
console.log("\nDistribute both files in the same directory.");
