<script lang="ts">
  import { fallbackIcon, iconMap, type IconName } from "$lib/icons";

  export let name: IconName = "activity";
  export let size = 20;
  export let stroke = 1.8;

  $: IconComponent = iconMap[name] ?? fallbackIcon;
</script>

<svelte:component
  this={IconComponent}
  {size}
  strokeWidth={stroke}
  aria-hidden="true"
/>
