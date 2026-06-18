import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["**/*.md", "prek.toml", "_typos.toml"],
  },
  lint: {
    plugins: ["typescript"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        files: ["packages/**/*.ts", "apps/spark/**/*.ts", "test/**/*.ts"],
        env: { node: true },
      },
    ],
  },
});
