<script lang="ts">
  let { children } = $props();
  import { page } from '$app/stores';
</script>
<div class="mx-auto max-w-2xl">
  <h1 class="section-title">Settings</h1>
  <nav class="mt-5 mb-8 flex gap-5 border-b pb-0" style="border-color: color-mix(in oklch, var(--color-surface-100) 8%, transparent);">
    <a href="/settings" class="settings-tab" class:settings-tab-active={$page.url.pathname === '/settings'}>General</a>
    <a href="/settings/ai" class="settings-tab" class:settings-tab-active={$page.url.pathname === '/settings/ai'}>AI</a>
    <a href="/settings/memory" class="settings-tab" class:settings-tab-active={$page.url.pathname === '/settings/memory'}>Memory</a>
    <a href="/settings/status" class="settings-tab" class:settings-tab-active={$page.url.pathname === '/settings/status'}>System</a>
  </nav>
  {@render children()}
</div>