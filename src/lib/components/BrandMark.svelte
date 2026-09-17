<script lang="ts">
  let { size = 36, class: className = '' }: { size?: number; class?: string } =
    $props();
</script>

<img
  src="/brand-mark.svg"
  width={size}
  height={size}
  alt=""
  aria-hidden="true"
  draggable="false"
  class={className}
/>
