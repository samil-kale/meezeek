const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tsconfig = path.join(__dirname, "tsconfig.json");
const dist = path.join(__dirname, "dist");

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  tsconfig
};

/** @type {import('esbuild').BuildOptions} */
const mainConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "main", "main.ts")],
  outfile: path.join(dist, "main.js"),
  platform: "node",
  target: "node22",
  format: "cjs",
  // electron is provided by the runtime; node-pty is a native addon and cannot be bundled.
  external: ["electron", "node-pty"]
};

/** The git CLI wrapper, which runs in a utilityProcess of its own — see CLAUDE.md. */
/** @type {import('esbuild').BuildOptions} */
const gitHostConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "main", "git-host.ts")],
  outfile: path.join(dist, "git-host.js"),
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"]
};

/** @type {import('esbuild').BuildOptions} */
const preloadConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "preload", "preload.ts")],
  outfile: path.join(dist, "preload.js"),
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"]
};

/** @type {import('esbuild').BuildOptions} */
const rendererConfig = {
  ...common,
  entryPoints: [path.join(__dirname, "src", "renderer", "main.tsx")],
  outfile: path.join(dist, "renderer.js"),
  platform: "browser",
  format: "iife",
  target: "chrome130"
};

function copyStaticAssets() {
  fs.mkdirSync(dist, { recursive: true });
  for (const file of ["index.html", "icon.png", "icon.ico"]) {
    fs.copyFileSync(path.join(__dirname, "src", "renderer", file), path.join(dist, file));
  }
}

async function build() {
  copyStaticAssets();

  const configs = [mainConfig, gitHostConfig, preloadConfig, rendererConfig];
  if (watch) {
    const contexts = await Promise.all(configs.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((context) => context.watch()));
  } else {
    await Promise.all(configs.map((config) => esbuild.build(config)));
  }
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
