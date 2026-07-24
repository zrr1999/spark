#!/usr/bin/env node

const rawSite = process.env.SPARK_DOCS_SITE_URL?.trim();
let site;

try {
  site = rawSite ? new URL(rawSite) : undefined;
} catch {
  site = undefined;
}

if (
  site?.protocol !== "https:" ||
  site.hostname === "spark-docs.invalid" ||
  site.pathname !== "/" ||
  site.search !== "" ||
  site.hash !== "" ||
  site.username !== "" ||
  site.password !== ""
) {
  console.error(
    "SPARK_DOCS_SITE_URL must be the canonical HTTPS origin for the deployed documentation site.",
  );
  process.exit(1);
}

console.log(`Spark docs canonical deployment origin: ${site.origin}`);
