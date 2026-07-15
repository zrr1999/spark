import { chmod } from "node:fs/promises";
import { build } from "esbuild";

await build({
  banner: {
    js: "#!/usr/bin/env node",
  },
  bundle: true,
  entryPoints: ["src/cli.ts"],
  external: [
    "ws",
    "@core-workspace/infoflow-sdk-nodejs",
    "@cursor/sdk",
    "axios",
    "protobufjs",
    "lodash.merge",
  ],
  format: "esm",
  outfile: "dist/cli.js",
  platform: "node",
  target: "node26",
});

await chmod("dist/cli.js", 0o755);
