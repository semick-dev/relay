import { build, context as createContext } from "esbuild";

const watch = process.argv.includes("--watch");

const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  bundle: true,
  minify: !watch,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "yaml"],
  sourcemap: watch,
  legalComments: "none",
  logLevel: "info"
};

const webviewOptions = [
  {
    entryPoints: ["media/main.js"],
    outfile: "media/dist/main.js",
    bundle: true,
    minify: !watch,
    format: "iife",
    target: "es2022",
    legalComments: "none",
    logLevel: "info"
  },
  {
    entryPoints: ["media/panel.js"],
    outfile: "media/dist/panel.js",
    bundle: true,
    minify: !watch,
    format: "iife",
    target: "es2022",
    legalComments: "none",
    logLevel: "info"
  }
];

if (watch) {
  const extensionContext = await createContext(extensionOptions);
  const webviewContexts = await Promise.all(webviewOptions.map((options) => createContext(options)));
  await Promise.all([
    extensionContext.watch(),
    ...webviewContexts.map((ctx) => ctx.watch())
  ]);
  console.log("Watching bundled extension and webview assets...");
} else {
  await build(extensionOptions);
  await Promise.all(webviewOptions.map((options) => build(options)));
}
