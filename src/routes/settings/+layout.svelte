<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  let { children } = $props();
  import { page } from '$app/state';
</script>

<div class="mx-auto max-w-2xl">
  <h1 class="section-title">Settings</h1>
  <nav
    class="mt-5 mb-8 flex flex-wrap gap-x-5 gap-y-2 border-b pb-0"
    style="border-color: color-mix(in oklch, var(--color-surface-100) 8%, transparent);"
    aria-label="Settings sections"
  >
    <a
      href="/settings"
      class="settings-tab inline-flex min-h-9 items-center"
      class:settings-tab-active={page.url.pathname === '/settings'}
      aria-current={page.url.pathname === '/settings' ? 'page' : undefined}
      >General</a
    >
    <a
      href="/settings/ai"
      class="settings-tab inline-flex min-h-9 items-center"
      class:settings-tab-active={page.url.pathname === '/settings/ai'}
      aria-current={page.url.pathname === '/settings/ai' ? 'page' : undefined}
      >AI</a
    >
    <a
      href="/settings/memory"
      class="settings-tab inline-flex min-h-9 items-center"
      class:settings-tab-active={page.url.pathname === '/settings/memory'}
      aria-current={page.url.pathname === '/settings/memory'
        ? 'page'
        : undefined}>Memory</a
    >
    <a
      href="/settings/webhooks"
      class="settings-tab inline-flex min-h-9 items-center"
      class:settings-tab-active={page.url.pathname === '/settings/webhooks'}
      aria-current={page.url.pathname === '/settings/webhooks'
        ? 'page'
        : undefined}>Webhooks</a
    >
    <a
      href="/settings/status"
      class="settings-tab inline-flex min-h-9 items-center"
      class:settings-tab-active={page.url.pathname === '/settings/status'}
      aria-current={page.url.pathname === '/settings/status'
        ? 'page'
        : undefined}>System</a
    >
  </nav>
  {@render children()}
</div>
