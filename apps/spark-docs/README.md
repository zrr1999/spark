# @zendev-lab/spark-docs

User-facing Spark documentation. This private workspace builds a bilingual
Astro/Starlight static site and has no runtime dependency on another Spark
workspace.

```text
pnpm run dev:docs
pnpm run check:docs
pnpm run build:docs
pnpm run preview:docs
```

The `CD - Docs` workflow deploys Cloudflare Workers Static Assets through the
official Wrangler Action after the documentation gate passes. Configure the
`docs-production` GitHub environment with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, and set the non-secret `SPARK_DOCS_SITE_URL` variable
to the canonical `https://spark-docs.<account-subdomain>.workers.dev` URL.
Continuous delivery fails before building if the canonical URL is missing or
invalid.

The fallback `https://spark-docs.invalid` URL exists only so local and pull
request builds can generate canonical and sitemap output. It must never be
deployed.
