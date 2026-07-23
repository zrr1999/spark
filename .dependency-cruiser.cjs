/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    // --- pi-ai boundary (audit gap): only spark-ai may import pi-ai directly ---
    {
      name: "no-direct-pi-ai",
      comment:
        "Direct @earendil-works/pi-ai imports must go through @zendev-lab/spark-ai. " +
        "apps/spark-tui/src/cli/pi-parity-commands.ts is WIP — exempt until the user commits cleanup.",
      severity: "error",
      from: {
        pathNot: "^(packages/spark-ai/|apps/spark-tui/src/cli/pi-parity-commands\\.ts$)",
      },
      to: {
        path: "node_modules/.*/@earendil-works/pi-ai|/node_modules/@earendil-works/pi-ai|^@earendil-works/pi-ai",
      },
    },

    // --- pi-tui boundary: only spark-tui / spark-text ---
    {
      name: "no-direct-pi-tui",
      comment:
        "Direct @earendil-works/pi-tui imports must stay behind @zendev-lab/spark-tui / spark-text. " +
        "direct pi-tui dependency must stay behind @zendev-lab/spark-tui; " +
        "direct pi-tui imports must go through @zendev-lab/spark-tui.",
      severity: "error",
      from: {
        pathNot: "^(packages/spark-tui/|packages/spark-text/)",
      },
      to: {
        path: "node_modules/.*/@earendil-works/pi-tui|/node_modules/@earendil-works/pi-tui|^@earendil-works/pi-tui",
      },
    },

    // --- deep-link: @zendev-lab/*/src/* specifier (bypass package exports) ---
    {
      name: "no-workspace-package-src-specifier",
      comment:
        "Do not import @zendev-lab/*/src/* — consume packages through declared package exports.",
      severity: "error",
      from: {},
      to: {
        path: "@zendev-lab/[^/]+/src(/|$)",
      },
    },

    // --- deep-link: relative packages/*/src from apps (root test/ exempted as known debt) ---
    {
      name: "no-app-relative-packages-src-deep-link",
      comment:
        "Do not reach into packages/*/src via relative paths. Use package exports. " +
        "Root test/ still uses deep relative imports (legacy); exempt until Phase 5 test migration. " +
        "Spark apps must consume workspace packages through declared package exports.",
      severity: "error",
      from: {
        path: "^apps/",
      },
      to: {
        path: "(^|/)packages/[^/]+/src(/|$)",
        dependencyTypes: ["local"],
      },
    },
    // --- deep-link: relative packages/*/src across different packages ---
    {
      name: "no-cross-package-relative-src-deep-link",
      comment: "Do not reach into another package's src via relative paths. Use package exports.",
      severity: "error",
      from: {
        path: "^packages/([^/]+)/",
      },
      to: {
        path: "^packages/(?!$1/)[^/]+/src/",
        dependencyTypes: ["local"],
      },
    },

    // --- pi-* packages (not pi-extension) ---
    {
      name: "pi-no-product-adapters",
      comment: "pi-* packages must not depend on Spark product adapter packages.",
      severity: "error",
      from: {
        path: "^packages/pi-(?!extension(?:/|$))",
      },
      to: {
        path: productAdapterResolvedPathPattern(),
      },
    },
    {
      name: "pi-only-foundation-spark",
      comment:
        "pi-* packages may depend only on renamed Spark foundation packages, not Spark product packages.",
      severity: "error",
      from: {
        path: "^packages/pi-(?!extension(?:/|$))",
      },
      to: {
        path: sparkOutsidePiFoundationResolvedPathPattern(),
      },
    },

    // --- pi-extension ---
    {
      name: "pi-extension-no-spark-tui",
      comment: "pi-extension must use @zendev-lab/spark-text instead of @zendev-lab/spark-tui.",
      severity: "error",
      from: {
        path: "^packages/pi-extension/",
      },
      to: {
        path: "node_modules/.*/@zendev-lab/spark-tui|/node_modules/@zendev-lab/spark-tui|^packages/spark-tui/",
      },
    },
    {
      name: "pi-extension-no-product-adapters",
      comment:
        "Spark core/runtime packages must not depend on product coordination or app adapter packages.",
      severity: "error",
      from: {
        path: "^packages/pi-extension/",
      },
      to: {
        path: productAdapterResolvedPathPattern(),
      },
    },
    {
      name: "pi-extension-no-app-internals",
      comment: "Spark shared packages must not import Spark app host internals.",
      severity: "error",
      from: {
        path: "^packages/pi-extension/",
      },
      to: {
        path: sparkAppInternalResolvedPathPattern(),
      },
    },

    // --- spark foundation packages (exclude cockpit-* private packages) ---
    {
      name: "spark-core-no-pi-extension",
      comment:
        "Spark foundation packages must not import pi-extension policy. " +
        "packages/spark-extension is the explicit Spark-native thin facade allowed to wrap it " +
        "while domains migrate out of the Pi-compatible package.",
      severity: "error",
      from: {
        path: "^packages/spark-(?!cockpit-|extension(?:/|$))",
      },
      to: {
        path: "node_modules/.*/@zendev-lab/pi-extension|/node_modules/@zendev-lab/pi-extension|^packages/pi-extension/",
      },
    },
    {
      name: "tui-no-pi-extension",
      comment:
        "apps/spark-tui must consume @zendev-lab/spark-extension, not @zendev-lab/pi-extension.",
      severity: "error",
      from: {
        path: "^apps/spark-tui/",
      },
      to: {
        path: "node_modules/.*/@zendev-lab/pi-extension|/node_modules/@zendev-lab/pi-extension|^packages/pi-extension/",
      },
    },
    {
      name: "spark-extension-no-product-adapters",
      comment: "spark-extension must not depend on product coordination or app adapter packages.",
      severity: "error",
      from: {
        path: "^packages/spark-extension/",
      },
      to: {
        path: productAdapterResolvedPathPattern(),
      },
    },
    {
      name: "spark-extension-no-app-internals",
      comment: "spark-extension must not import Spark app host internals.",
      severity: "error",
      from: {
        path: "^packages/spark-extension/",
      },
      to: {
        path: sparkAppInternalResolvedPathPattern(),
      },
    },
    {
      name: "spark-core-no-product-adapters",
      comment:
        "Spark core/runtime packages must not depend on product coordination or app adapter packages.",
      severity: "error",
      from: {
        // Cockpit-private packages (spark-cockpit-*) are product adapters; exclude them.
        path: "^packages/spark-(?!cockpit-)",
      },
      to: {
        path: productAdapterResolvedPathPattern(),
      },
    },
    {
      name: "spark-core-no-app-internals",
      comment: "Spark shared packages must not import Spark app host internals.",
      severity: "error",
      from: {
        path: "^packages/spark-(?!cockpit-)",
      },
      to: {
        path: sparkAppInternalResolvedPathPattern(),
      },
    },

    // --- foundation contract packages (protocol + core) ---
    {
      name: "foundation-contract-no-product-or-app",
      comment:
        "foundation contract packages must not depend on product coordination or app adapters.",
      severity: "error",
      from: {
        path: "^packages/spark-(protocol|core)/",
      },
      to: {
        path: `(${productAdapterResolvedPathPattern()})|(${sparkAppInternalResolvedPathPattern()})`,
      },
    },

    // --- daemon-app ---
    {
      name: "daemon-no-tui-app",
      comment:
        "spark-daemon must use @zendev-lab/spark-host/headless-loader instead of @zendev-lab/spark-tui-app.",
      severity: "error",
      from: {
        path: "^apps/spark-daemon/",
      },
      to: {
        path: "node_modules/.*/@zendev-lab/spark-tui-app|/node_modules/@zendev-lab/spark-tui-app|^apps/spark-tui/",
      },
    },

    // --- cockpit-app / cockpit-package ---
    {
      name: "cockpit-no-app-internals",
      comment: "Cockpit packages must not import Spark CLI host internals.",
      severity: "error",
      from: {
        path: "^(apps/spark-cockpit/|packages/spark-cockpit-)",
      },
      to: {
        path: sparkAppInternalResolvedPathPattern(),
      },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules", "dist", "\\.svelte-kit", "reports", "coverage"],
    },
    exclude: {
      path: [
        "node_modules",
        "dist",
        "\\.svelte-kit",
        "reports",
        "coverage",
        "\\.git",
        // package-internal relative imports into own src are fine; deep-link rule
        // already scopes local deps. Keep generated / lock noise out.
      ],
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    // Dynamic import() detection stays on (default). Do not disable via
    // detective options or skipAnalysis.
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};

/** Resolved paths / module names for product adapter packages. */
function productAdapterResolvedPathPattern() {
  return [
    "node_modules/.*/@zendev-lab/spark-cockpit(?:/|$)",
    "/node_modules/@zendev-lab/spark-cockpit(?:/|$)",
    "^apps/spark-cockpit/",
    "node_modules/.*/@zendev-lab/spark-daemon(?:/|$)",
    "/node_modules/@zendev-lab/spark-daemon(?:/|$)",
    "^apps/spark-daemon/",
    "node_modules/.*/@zendev-lab/spark-cockpit-coordination(?:/|$)",
    "/node_modules/@zendev-lab/spark-cockpit-coordination(?:/|$)",
    "^packages/spark-cockpit-coordination/",
    "node_modules/.*/@zendev-lab/spark-cockpit-[^/]+",
    "/node_modules/@zendev-lab/spark-cockpit-[^/]+",
    "^packages/spark-cockpit-",
  ].join("|");
}

function piAllowedSparkFoundationDirs() {
  return [
    "spark-artifacts",
    "spark-core",
    "spark-host",
    "spark-loop",
    "spark-modes",
    "spark-tasks",
    "spark-turn",
    "spark-workflows",
    // Old script treated spark-tui as non-spark for the foundation allowlist check
    // (isSparkSpecifier returned false for spark-tui). Keep spark-text similarly allowed.
    "spark-tui",
    "spark-text",
  ];
}

function sparkOutsidePiFoundationResolvedPathPattern() {
  const allowed = piAllowedSparkFoundationDirs().join("|");
  return [
    `node_modules/.*/@zendev-lab/spark-(?!${allowed})(?:$|/)`,
    `/node_modules/@zendev-lab/spark-(?!${allowed})(?:$|/)`,
    `^packages/spark-(?!${allowed})(?:/|$)`,
  ].join("|");
}

function sparkAppInternalResolvedPathPattern() {
  return [
    "node_modules/.*/@zendev-lab/spark-cli(?:/|$)",
    "/node_modules/@zendev-lab/spark-cli(?:/|$)",
    "node_modules/.*/@zendev-lab/spark-tui-app(?:/|$)",
    "/node_modules/@zendev-lab/spark-tui-app(?:/|$)",
    "^apps/spark-tui/",
    "^apps/spark-cli/",
  ].join("|");
}
