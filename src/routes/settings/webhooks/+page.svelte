<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { tick } from 'svelte';
  import { addToast } from '$lib/stores/toast.svelte';
  import { fly, fade } from 'svelte/transition';
  import { fetchWithCsrf } from '$lib/client/csrf';

  let { data } = $props();

  let name = $state('');
  let url = $state('');
  let secret = $state('');
  let selectedEvents = $state(['article.saved']);
  let addError = $state('');
  let addErrorField = $state<'name' | 'url' | 'events' | 'form' | null>(null);

  let isSubmitting = $state(false);

  async function handleAdd(event: SubmitEvent) {
    event.preventDefault();
    if (isSubmitting) return;

    addError = '';
    addErrorField = null;
    if (!name.trim()) {
      addError = 'Enter a name for this webhook.';
      addErrorField = 'name';
      return;
    }
    if (!url.trim()) {
      addError = 'Enter a target URL.';
      addErrorField = 'url';
      return;
    }
    if (selectedEvents.length === 0) {
      addError = 'Choose at least one event.';
      addErrorField = 'events';
      return;
    }

    isSubmitting = true;

    try {
      const res = await fetchWithCsrf('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          secret,
          events: selectedEvents,
        }),
      });

      if (res.ok) {
        name = '';
        url = '';
        secret = '';
        selectedEvents = ['article.saved'];
        addError = '';
        addErrorField = null;
        addToast('Webhook added successfully', 'success');
        await invalidateAll();
      } else {
        const err = await res.json();
        addError = err.error || 'Failed to add webhook';
        addErrorField = ['name', 'url', 'events'].includes(err.field)
          ? err.field
          : 'form';
      }
    } catch {
      addError =
        'Could not add this webhook. Check your connection and try again.';
      addErrorField = 'form';
    } finally {
      isSubmitting = false;
    }
  }

  async function toggleWebhook(hook: any) {
    try {
      const res = await fetchWithCsrf('/api/webhooks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: hook.id, enabled: !hook.enabled }),
      });

      if (res.ok) {
        addToast(
          `Webhook ${!hook.enabled ? 'enabled' : 'disabled'}`,
          'success',
        );
        await invalidateAll();
      }
    } catch (err) {
      addToast('Failed to update webhook', 'error');
    }
  }

  async function deleteHook(id: string) {
    if (!confirm('Are you sure you want to delete this webhook?')) return;
    const index = data.webhooks.findIndex((hook: any) => hook.id === id);

    try {
      const res = await fetchWithCsrf('/api/webhooks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });

      if (res.ok) {
        addToast('Webhook deleted', 'success');
        await invalidateAll();
        await tick();
        const deleteButtons = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-webhook-delete]'),
        );
        (
          deleteButtons[Math.min(index, deleteButtons.length - 1)] ||
          document.getElementById('active-webhooks-heading')
        )?.focus();
      }
    } catch (err) {
      addToast('Failed to delete webhook', 'error');
    }
  }
</script>

<svelte:head>
  <title>Webhooks · Feed Me Maybe</title>
</svelte:head>

<div class="space-y-6">
  <section class="glass-card p-5 md:p-6" in:fly={{ y: 12, duration: 320 }}>
    <h2
      id="active-webhooks-heading"
      tabindex="-1"
      class="mb-4 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><path
          d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
        /><path
          d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
        /></svg
      >
      Register New Webhook
    </h2>

    <form
      class="grid gap-4"
      onsubmit={handleAdd}
      aria-describedby={addError && addErrorField === 'form'
        ? 'webhook-add-error'
        : undefined}
    >
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label class="label">
          <span class="mb-1 block font-medium opacity-80">Name</span>
          <input
            id="webhook-name"
            type="text"
            bind:value={name}
            oninput={() => {
              if (addErrorField === 'name' || addErrorField === 'form') {
                addError = '';
                addErrorField = null;
              }
            }}
            placeholder="e.g. OpenCCLaw Research"
            class="input glass-input text-sm"
            aria-invalid={addErrorField === 'name' ? 'true' : undefined}
            aria-describedby={addErrorField === 'name'
              ? 'webhook-name-help webhook-add-error'
              : 'webhook-name-help'}
            required
          />
          <span id="webhook-name-help" class="mt-1 block text-xs opacity-60">
            Required. Use a label you will recognize later.
          </span>
        </label>
        <label class="label">
          <span class="mb-1 block font-medium opacity-80">Target URL</span>
          <input
            id="webhook-url"
            type="url"
            bind:value={url}
            oninput={() => {
              if (addErrorField === 'url' || addErrorField === 'form') {
                addError = '';
                addErrorField = null;
              }
            }}
            placeholder="https://your-api.com/webhook"
            class="input glass-input text-sm"
            aria-invalid={addErrorField === 'url' ? 'true' : undefined}
            aria-describedby={addErrorField === 'url'
              ? 'webhook-url-help webhook-add-error'
              : 'webhook-url-help'}
            required
          />
          <span id="webhook-url-help" class="mt-1 block text-xs opacity-60">
            Required. Use a public HTTP or HTTPS endpoint.
          </span>
        </label>
      </div>

      <label class="label">
        <span class="mb-1 block font-medium opacity-80"
          >Signing Secret (Optional)</span
        >
        <input
          id="webhook-secret"
          type="password"
          bind:value={secret}
          placeholder="A secret key for HMAC-SHA256"
          class="input glass-input text-sm"
          aria-describedby="webhook-secret-help"
        />
        <p id="webhook-secret-help" class="mt-1 text-sm opacity-50">
          If provided, payloads will be signed with HMAC-SHA256 in the <code
            >X-Feed-Me-Maybe-Signature</code
          > header.
        </p>
      </label>

      <fieldset
        class="space-y-2"
        onchange={() => {
          if (addErrorField === 'events' || addErrorField === 'form') {
            addError = '';
            addErrorField = null;
          }
        }}
        aria-describedby={addErrorField === 'events'
          ? 'webhook-events-help webhook-add-error'
          : 'webhook-events-help'}
      >
        <legend class="font-medium opacity-80">Events (required)</legend>
        <p id="webhook-events-help" class="text-xs opacity-60">
          Choose at least one event to receive.
        </p>
        <div class="flex flex-wrap gap-4">
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              value="article.saved"
              bind:group={selectedEvents}
              class="checkbox"
              aria-invalid={addErrorField === 'events' ? 'true' : undefined}
              aria-describedby={addErrorField === 'events'
                ? 'webhook-events-help webhook-add-error'
                : 'webhook-events-help'}
            />
            <span class="opacity-70">Article Saved</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              value="article.ingested"
              bind:group={selectedEvents}
              class="checkbox"
              aria-invalid={addErrorField === 'events' ? 'true' : undefined}
              aria-describedby={addErrorField === 'events'
                ? 'webhook-events-help webhook-add-error'
                : 'webhook-events-help'}
            />
            <span class="opacity-70">Article Ingested</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              value="article.thumbs_up"
              bind:group={selectedEvents}
              class="checkbox"
              aria-invalid={addErrorField === 'events' ? 'true' : undefined}
              aria-describedby={addErrorField === 'events'
                ? 'webhook-events-help webhook-add-error'
                : 'webhook-events-help'}
            />
            <span class="opacity-70">Article Liked</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              value="article.read"
              bind:group={selectedEvents}
              class="checkbox"
              aria-invalid={addErrorField === 'events' ? 'true' : undefined}
              aria-describedby={addErrorField === 'events'
                ? 'webhook-events-help webhook-add-error'
                : 'webhook-events-help'}
            />
            <span class="opacity-70">Article Read</span>
          </label>
        </div>
      </fieldset>

      {#if addError}
        <p id="webhook-add-error" class="text-sm text-error-300" role="alert">
          {addError}
        </p>
      {/if}

      <div class="pt-2">
        <button
          type="submit"
          disabled={isSubmitting}
          class="btn preset-filled-primary-500 flex items-center gap-2 text-sm"
        >
          {#if isSubmitting}
            <div
              class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"
            ></div>
            Adding...
          {:else}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"><path d="M5 12h14" /><path d="M12 5v14" /></svg
            >
            Add Webhook
          {/if}
        </button>
      </div>
    </form>
  </section>

  <section in:fly={{ y: 12, duration: 320, delay: 100 }}>
    <h2
      class="mb-4 flex items-center gap-2 text-sm font-semibold"
      style="color: var(--color-surface-100);"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg
      >
      Active Webhooks
    </h2>

    {#if data.webhooks.length === 0}
      <div
        class="glass-card flex flex-col items-center justify-center p-10 text-center opacity-40"
      >
        <p class="text-sm">No webhooks registered yet.</p>
      </div>
    {:else}
      <div class="grid gap-3">
        {#each data.webhooks as hook}
          <div
            class="glass-card flex items-center justify-between p-4 transition-all hover:bg-white/5"
          >
            <div class="grid gap-1">
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold text-white">{hook.name}</span>
                {#if !hook.enabled}
                  <span class="badge variant-soft-surface text-sm uppercase"
                    >Disabled</span
                  >
                {/if}
              </div>
              <code class="truncate text-sm opacity-40" title={hook.url}
                >{hook.url}</code
              >
              <div class="mt-1 flex gap-2">
                {#each hook.events as event}
                  <span class="badge variant-soft-primary text-sm">{event}</span
                  >
                {/each}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button
                onclick={() => toggleWebhook(hook)}
                class="btn variant-soft-surface btn-sm"
              >
                {hook.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                onclick={() => deleteHook(hook.id)}
                data-webhook-delete={hook.id}
                class="btn variant-soft-error btn-sm"
              >
                Delete
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section
    class="glass-card p-5 md:p-6"
    in:fly={{ y: 12, duration: 320, delay: 200 }}
    style="border-color: rgba(var(--color-primary-500) / 0.2); background: rgba(var(--color-primary-500) / 0.03);"
  >
    <h2
      class="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-400"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        ><path
          d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"
        /><path d="M8 7h6" /><path d="M8 11h8" /></svg
      >
      Integration Guide
    </h2>
    <div class="prose prose-sm max-w-none dark:prose-invert">
      <p class="opacity-70">
        Webhooks send real-time POST notifications to your services. For
        example, use them to push saved articles to <a
          href="https://github.com/opencclaw"
          target="_blank"
          class="text-primary-400 hover:underline">OpenCCLaw</a
        > for automated research reports.
      </p>

      <div class="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div class="space-y-2">
          <h3 class="text-sm font-bold uppercase tracking-wider opacity-40">
            Available Events
          </h3>
          <ul class="m-0 list-none p-0 text-sm space-y-1 opacity-70">
            <li><code>article.saved</code> — When an article is bookmarked</li>
            <li>
              <code>article.ingested</code> — When a new article is discovered
            </li>
            <li><code>article.thumbs_up</code> — When an article is liked</li>
            <li><code>article.read</code> — When an article is opened/read</li>
          </ul>
        </div>
        <div class="space-y-2">
          <h3 class="text-sm font-bold uppercase tracking-wider opacity-40">
            Request Headers
          </h3>
          <ul class="m-0 list-none p-0 text-sm space-y-1 opacity-70">
            <li><code>X-Feed-Me-Maybe-Event</code> — Event Type</li>
            <li><code>X-Feed-Me-Maybe-Delivery</code> — UUID</li>
            <li><code>X-Feed-Me-Maybe-Signature</code> — HMAC-SHA256</li>
          </ul>
        </div>
      </div>

      <div class="mt-6 space-y-2">
        <h3 class="text-sm font-bold uppercase tracking-wider opacity-40">
          Payload Example
        </h3>
        <pre
          class="m-0 overflow-auto rounded bg-black/30 p-2 text-sm text-primary-200"><code
            >{`{
  "type": "article.saved",
  "payload": {
    "article": {
      "title": "...",
      "url": "..."
    }
  }
}`}</code
          ></pre>
      </div>
    </div>
  </section>
</div>

<style>
  .glass-input {
    background: rgba(255, 255, 255, 0.03);
    border-color: rgba(255, 255, 255, 0.1);
  }
  .glass-input:focus {
    background: rgba(255, 255, 255, 0.05);
    border-color: var(--color-primary-500);
    box-shadow: 0 0 0 2px rgba(var(--color-primary-500) / 0.1);
  }
  code {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
      'Courier New', monospace;
  }
</style>
