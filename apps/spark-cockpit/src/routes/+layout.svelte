<script lang="ts">
  import "$lib/tokens.css";

  let { children } = $props();
</script>

<svelte:head>
  <meta name="theme-color" content="#2563EB" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Spark" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/spark.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icons/spark-maskable.svg" />
</svelte:head>

{@render children()}
