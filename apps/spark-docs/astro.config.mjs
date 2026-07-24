import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const docsLocaleStorageKey = "spark-docs-locale";
const productionSite = process.env.SPARK_DOCS_SITE_URL?.trim() || "https://spark-docs.invalid";
const localeRedirectScript = `
  (() => {
    if (window.location.pathname !== '/') return;
    if (window.localStorage.getItem(${JSON.stringify(docsLocaleStorageKey)}) === 'zh') {
      window.location.replace('/zh/');
    }
  })();
`.trim();

export default defineConfig({
  output: "static",
  site: productionSite,
  integrations: [
    starlight({
      title: {
        en: "Spark Docs",
        "zh-CN": "Spark 文档",
      },
      description:
        "Install, operate, and understand Spark across its CLI, TUI, daemon, and Cockpit surfaces.",
      tagline: "User documentation for the Spark coding-agent suite.",
      favicon: "/spark.svg",
      editLink: {
        baseUrl: "https://github.com/zrr1999/spark/edit/main/apps/spark-docs/",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/zrr1999/spark",
        },
      ],
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        zh: {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      defaultLocale: "root",
      sidebar: [
        {
          label: "Start",
          translations: { zh: "开始" },
          items: [
            {
              label: "Overview",
              translations: { zh: "概览" },
              link: "/",
            },
            {
              label: "Getting started",
              translations: { zh: "快速开始" },
              link: "/getting-started/",
            },
            {
              label: "Surfaces and ownership",
              translations: { zh: "界面与所有权" },
              link: "/concepts/surfaces/",
            },
          ],
        },
        {
          label: "Use Spark",
          translations: { zh: "使用 Spark" },
          items: [
            {
              label: "Runs and sessions",
              translations: { zh: "运行与会话" },
              link: "/guides/runs-and-sessions/",
            },
            {
              label: "Side Threads",
              translations: { zh: "Side Threads" },
              link: "/guides/side-threads/",
            },
            {
              label: "Cockpit",
              translations: { zh: "Cockpit" },
              link: "/guides/cockpit/",
            },
          ],
        },
        {
          label: "Reference",
          translations: { zh: "参考" },
          items: [
            {
              label: "Configuration and paths",
              translations: { zh: "配置与路径" },
              link: "/reference/configuration-and-paths/",
            },
            {
              label: "CLI",
              translations: { zh: "CLI" },
              link: "/reference/cli/",
            },
            {
              label: "Troubleshooting",
              translations: { zh: "故障排查" },
              link: "/troubleshooting/",
            },
          ],
        },
      ],
      head: [
        {
          tag: "script",
          attrs: { "data-spark-locale-redirect": "true" },
          content: localeRedirectScript,
        },
      ],
      customCss: ["./src/styles/custom.css"],
      components: {
        LanguageSelect: "./src/components/LanguageSelect.astro",
      },
      credits: false,
    }),
  ],
});
