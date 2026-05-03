<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  let password = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleLogin(event: Event) {
    event.preventDefault();
    loading = true;
    error = '';

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (response.ok) {
        window.location.href = '/';
      } else {
        const data = await response.json();
        error = data.error || 'Login failed';
      }
    } catch {
      error = 'Connection error. Please try again.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="flex min-h-full items-center justify-center p-4">
  <div class="w-full max-w-sm">
    <!-- App title -->
    <div class="mb-8 text-center" in:fade={{ duration: 400 }}>
      <h1 class="gradient-text text-4xl font-extrabold tracking-tight">
        Feed Me Maybe
      </h1>
      <p
        class="mt-3 text-sm"
        style="color: color-mix(in oklch, var(--color-surface-200) 50%, transparent);"
      >
        AI-powered RSS reader
      </p>
    </div>

    <!-- Login card -->
    <div class="glass-card p-7" in:fly={{ y: 18, duration: 400, delay: 100 }}>
      <form onsubmit={handleLogin} class="space-y-4">
        <label class="label">
          <span
            class="mb-1 block text-sm font-medium"
            style="color: var(--color-surface-100);">Password</span
          >
          <input
            class="input glass-input w-full"
            type="password"
            bind:value={password}
            placeholder="Enter your password"
            autocomplete="current-password"
            required
          />
        </label>

        {#if error}
          <div
            class="flex items-center gap-2 px-3 py-2 text-sm"
            style="background: color-mix(in oklch, var(--color-error-500) 10%, transparent); color: var(--color-error-300); border: 1px solid color-mix(in oklch, var(--color-error-500) 20%, transparent); border-radius: 2px;"
            role="alert"
            in:fly={{ y: 4, duration: 200 }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              ><circle cx="12" cy="12" r="10" /><line
                x1="12"
                y1="8"
                x2="12"
                y2="12"
              /><line x1="12" y1="16" x2="12.01" y2="16" /></svg
            >
            {error}
          </div>
        {/if}

        <button
          type="submit"
          disabled={loading}
          class="btn preset-filled-primary-500 w-full inline-flex items-center justify-center gap-2"
        >
          {#if loading}
            <svg
              class="animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg
            >
            Signing in...
          {:else}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              ><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline
                points="10 17 15 12 10 7"
              /><line x1="15" y1="12" x2="3" y2="12" /></svg
            >
            Sign in
          {/if}
        </button>
      </form>
    </div>

    <!-- Footer note -->
    <p
      class="mt-6 text-center text-xs"
      style="color: color-mix(in oklch, var(--color-surface-200) 35%, transparent);"
    >
      This is a private self-hosted application.
    </p>
  </div>
</div>
