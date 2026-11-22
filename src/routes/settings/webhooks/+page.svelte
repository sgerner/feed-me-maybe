<script lang="ts">
  import { refreshAll } from '$app/navigation';
  import { tick } from 'svelte';
  import { addToast } from '#lib/stores/toast.svelte.ts';
  import { fly } from 'svelte/transition';
  import { fetchWithCsrf } from '#lib/client/csrf.ts';

  const EVENT_OPTIONS = [
    { value: 'article.saved', label: 'Article Saved' },
    { value: 'article.ingested', label: 'Article Ingested' },
    { value: 'article.thumbs_up', label: 'Article Liked' },
    { value: 'article.read', label: 'Article Read' },
  ] as const;

  let { data } = $props();

  let name = $state('');
  let url = $state('');
  let secret = $state('');
  let selectedEvents = $state(['article.saved']);
  let addError = $state('');
  let addErrorField = $state<'name' | 'url' | 'events' | 'form' | null>(null);
  let isSubmitting = $state(false);

  let editingHookId = $state<string | null>(null);
  let editName = $state('');
  let editUrl = $state('');
  let editSecret = $state('');
  let editEvents = $state<string[]>([]);
  let editError = $state('');
  let editSaving = $state(false);

  let confirmingDeleteId = $state<string | null>(null);
  let deletingId = $state<string | null>(null);
  let togglingId = $state<string | null>(null);
  let testingId = $state<string | null>(null);
  let actionError = $state('');
  let testResults = $state<
    Record<
      string,
      {
        ok: boolean;
        status: number | null;
        durationMs: number;
        error: string | null;
      }
    >
  >({});

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
        await refreshAll();
      } else {
        const err = await res.json().catch(() => ({}));
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

  function startEdit(hook: any) {
    confirmingDeleteId = null;
    editingHookId = hook.id;
    editName = hook.name || '';
    editUrl = hook.url || '';
    editSecret = '';
    editEvents = Array.isArray(hook.events) ? [...hook.events] : [];
    editError = '';
  }

  function cancelEdit() {
    editingHookId = null;
    editError = '';
    editSecret = '';
  }

  async function saveEdit(event: SubmitEvent, hook: any) {
    event.preventDefault();
    if (editSaving) return;

    editError = '';
    if (!editName.trim()) {
      editError = 'Enter a name for this webhook.';
      return;
    }
    if (!editUrl.trim()) {
      editError = 'Enter a target URL.';
      return;
    }
    if (editEvents.length === 0) {
      editError = 'Choose at least one event.';
      return;
    }

    editSaving = true;
    try {
      const payload: Record<string, unknown> = {
        name: editName.trim(),
        url: editUrl.trim(),
        events: editEvents,
      };
      if (editSecret.trim()) {
        payload.secret = editSecret.trim();
      }
      const res = await fetchWithCsrf(`/api/webhooks/${hook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        editingHookId = null;
        editSecret = '';
        editError = '';
        addToast(`Updated webhook "${payload.name}"`, 'success');
        await refreshAll();
      } else {
        const err = await res.json().catch(() => ({}));
        editError = err.error || 'Failed to update webhook.';
        addToast(editError, 'error');
      }
    } catch {
      editError =
        'Could not update this webhook. Check your connection and try again.';
      addToast(editError, 'error');
    } finally {
      editSaving = false;
    }
  }

  async function toggleWebhook(hook: any) {
    if (togglingId === hook.id) return;
    togglingId = hook.id;
    actionError = '';
    try {
      const res = await fetchWithCsrf(`/api/webhooks/${hook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !hook.enabled }),
      });

      if (res.ok) {
        addToast(
          `Webhook ${!hook.enabled ? 'enabled' : 'disabled'}`,
          'success',
        );
        await refreshAll();
      } else {
        const err = await res.json().catch(() => ({}));
        const message = err.error || 'Failed to update webhook';
        actionError = message;
        addToast(message, 'error');
      }
    } catch {
      actionError = 'Failed to update webhook';
      addToast(actionError, 'error');
    } finally {
      togglingId = null;
    }
  }

  async function runTest(hook: any) {
    if (testingId === hook.id) return;
    testingId = hook.id;
    actionError = '';
    try {
      const res = await fetchWithCsrf(`/api/webhooks/${hook.id}/test`, {
        method: 'POST',
      });
      const result = (await res.json().catch(() => ({
        ok: false,
        status: res.status,
        durationMs: 0,
        error: 'Failed to test webhook',
      }))) as {
        ok: boolean;
        status: number | null;
        durationMs: number;
        error: string | null;
      };
      testResults = { ...testResults, [hook.id]: result };
      if (res.ok && result.ok) {
        addToast(
          `Test ping delivered to "${hook.name}" (HTTP ${result.status} · ${result.durationMs}ms)`,
          'success',
        );
      } else {
        addToast(result.error || `Test ping to "${hook.name}" failed`, 'error');
      }
      await refreshAll();
    } catch {
      const failed = {
        ok: false,
        status: null,
        durationMs: 0,
        error: 'Network error while testing webhook',
      };
      testResults = { ...testResults, [hook.id]: failed };
      addToast(failed.error, 'error');
    } finally {
      testingId = null;
    }
  }

  async function promptDelete(id: string) {
    confirmingDeleteId = id;
    actionError = '';
    await tick();
    document
      .querySelector<HTMLButtonElement>(`[data-webhook-confirm-delete="${id}"]`)
      ?.focus();
  }

  async function cancelDelete(id: string) {
    confirmingDeleteId = null;
    await tick();
    document
      .querySelector<HTMLButtonElement>(`[data-webhook-delete="${id}"]`)
      ?.focus();
  }

  async function confirmDelete(id: string) {
    if (deletingId === id) return;
    const index = data.webhooks.findIndex((hook: any) => hook.id === id);
    deletingId = id;
    actionError = '';

    try {
      const res = await fetchWithCsrf(`/api/webhooks/${id}`, {
        method: 'DELETE',
      });

      if (res.ok) {
        confirmingDeleteId = null;
        addToast('Webhook deleted', 'success');
        await refreshAll();
        await tick();
        const deleteButtons = Array.from(
          document.querySelectorAll<HTMLButtonElement>('[data-webhook-delete]'),
        );
        (
          deleteButtons[Math.min(index, deleteButtons.length - 1)] ||
          document.getElementById('active-webhooks-heading')
        )?.focus();
      } else {
        const err = await res.json().catch(() => ({}));
        const message = err.error || 'Failed to delete webhook';
        actionError = message;
        addToast(message, 'error');
      }
    } catch {
      actionError = 'Failed to delete webhook';
      addToast(actionError, 'error');
    } finally {
      deletingId = null;
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
        aria-hidden="true"
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
          If provided, payloads will be signed with HMAC-SHA256 (<code
            >sha256=&lt;hex&gt;</code
          >) in the <code>X-Feed-Me-Maybe-Signature</code> header.
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
          {#each EVENT_OPTIONS as option (option.value)}
            <label class="flex min-h-7 items-center gap-2 text-sm">
              <input
                type="checkbox"
                value={option.value}
                bind:group={selectedEvents}
                class="checkbox"
                aria-invalid={addErrorField === 'events' ? 'true' : undefined}
                aria-describedby={addErrorField === 'events'
                  ? 'webhook-events-help webhook-add-error'
                  : 'webhook-events-help'}
              />
              <span class="opacity-70">{option.label}</span>
            </label>
          {/each}
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
              stroke-width="2"
              aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg
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
        stroke-width="2"
        aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg
      >
      Active Webhooks
    </h2>

    {#if actionError}
      <p
        class="mb-3 rounded border border-error-500/30 bg-error-500/10 px-3 py-2 text-sm text-error-300"
        role="alert"
      >
        {actionError}
      </p>
    {/if}

    {#if data.webhooks.length === 0}
      <div
        class="glass-card flex flex-col items-center justify-center p-10 text-center opacity-40"
      >
        <p class="text-sm">No webhooks registered yet.</p>
      </div>
    {:else}
      <div class="grid gap-3">
        {#each data.webhooks as hook (hook.id)}
          <div class="glass-card p-4 transition-all hover:bg-white/5">
            <div
              class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
            >
              <div class="min-w-0 flex-1 space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm font-bold text-surface-50"
                    >{hook.name}</span
                  >
                  {#if !hook.enabled}
                    <span
                      class="rounded-full bg-surface-200/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-surface-300"
                      >Disabled</span
                    >
                  {:else}
                    <span
                      class="rounded-full bg-success-500/15 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-success-300"
                      >Active</span
                    >
                  {/if}
                  {#if hook.has_secret}
                    <span
                      class="rounded-full bg-primary-500/15 px-2.5 py-0.5 text-xs font-semibold text-primary-300"
                      >Signed (HMAC-SHA256)</span
                    >
                  {:else}
                    <span
                      class="rounded-full bg-surface-200/10 px-2.5 py-0.5 text-xs text-surface-300"
                      >Unsigned</span
                    >
                  {/if}
                  {#if hook.last_error}
                    <span
                      class="rounded-full bg-error-500/15 px-2.5 py-0.5 text-xs font-semibold text-error-300"
                      >Delivery failed</span
                    >
                  {/if}
                </div>
                <code
                  class="block max-w-full break-all text-xs text-surface-300"
                  title={hook.url}>{hook.url}</code
                >
                <div class="flex flex-wrap gap-1.5">
                  {#each hook.events as event (event)}
                    <span
                      class="rounded bg-primary-500/10 px-2 py-0.5 text-xs font-medium text-primary-300"
                      >{event}</span
                    >
                  {/each}
                </div>
                {#if hook.last_error}
                  <p class="text-xs text-error-300" role="status">
                    Last failure: {hook.last_error}
                  </p>
                {/if}
                {#if testResults[hook.id]}
                  {@const testResult = testResults[hook.id]}
                  <p
                    class="text-xs {testResult.ok
                      ? 'text-success-300'
                      : 'text-error-300'}"
                    role="status"
                  >
                    {#if testResult.ok}
                      Test ping succeeded (HTTP {testResult.status} · {testResult.durationMs}ms)
                    {:else}
                      Test ping failed{testResult.status
                        ? ` (HTTP ${testResult.status})`
                        : ''}: {testResult.error || 'Delivery error'} ({testResult.durationMs}ms)
                    {/if}
                  </p>
                {/if}
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onclick={() => toggleWebhook(hook)}
                  disabled={togglingId === hook.id}
                  aria-label="{hook.enabled
                    ? 'Disable'
                    : 'Enable'} webhook {hook.name}"
                  class="btn preset-tonal px-3 py-1.5 text-xs"
                >
                  {hook.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  onclick={() => startEdit(hook)}
                  aria-label="Edit webhook {hook.name}"
                  aria-expanded={editingHookId === hook.id}
                  class="btn preset-tonal px-3 py-1.5 text-xs"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onclick={() => runTest(hook)}
                  disabled={testingId === hook.id}
                  aria-label="Test webhook {hook.name}"
                  class="btn preset-tonal px-3 py-1.5 text-xs"
                >
                  {testingId === hook.id ? 'Testing…' : 'Test'}
                </button>
                {#if confirmingDeleteId === hook.id}
                  <div
                    class="flex flex-wrap items-center gap-2 rounded border border-error-500/30 bg-error-500/10 px-2.5 py-1"
                    role="group"
                    aria-label="Confirm deleting webhook {hook.name}"
                  >
                    <span class="text-xs text-error-300">Delete?</span>
                    <button
                      type="button"
                      data-webhook-confirm-delete={hook.id}
                      disabled={deletingId === hook.id}
                      onclick={() => confirmDelete(hook.id)}
                      aria-label="Confirm delete webhook {hook.name}"
                      class="btn preset-tonal-error px-2.5 py-1 text-xs font-semibold"
                    >
                      {deletingId === hook.id ? 'Deleting…' : 'Confirm'}
                    </button>
                    <button
                      type="button"
                      onclick={() => cancelDelete(hook.id)}
                      aria-label="Cancel delete webhook {hook.name}"
                      class="btn preset-tonal px-2.5 py-1 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                {:else}
                  <button
                    type="button"
                    onclick={() => promptDelete(hook.id)}
                    data-webhook-delete={hook.id}
                    aria-label="Delete webhook {hook.name}"
                    class="btn preset-tonal-error px-3 py-1.5 text-xs"
                  >
                    Delete
                  </button>
                {/if}
              </div>
            </div>

            {#if editingHookId === hook.id}
              <form
                class="mt-4 grid gap-3 border-t border-white/10 pt-4"
                onsubmit={(event) => saveEdit(event, hook)}
              >
                <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label class="label">
                    <span
                      class="mb-1 block text-xs font-medium text-surface-200"
                      >Name</span
                    >
                    <input
                      type="text"
                      bind:value={editName}
                      class="input glass-input text-sm"
                      required
                    />
                  </label>
                  <label class="label">
                    <span
                      class="mb-1 block text-xs font-medium text-surface-200"
                      >Target URL</span
                    >
                    <input
                      type="url"
                      bind:value={editUrl}
                      class="input glass-input text-sm"
                      required
                    />
                  </label>
                </div>
                <label class="label">
                  <span class="mb-1 block text-xs font-medium text-surface-200">
                    Rotate Signing Secret (Optional)
                  </span>
                  <input
                    type="password"
                    bind:value={editSecret}
                    placeholder={hook.has_secret
                      ? 'Leave blank to keep existing signing secret'
                      : 'Enter a secret to enable HMAC-SHA256 signing'}
                    class="input glass-input text-sm"
                  />
                </label>
                <fieldset class="space-y-1.5">
                  <legend class="text-xs font-medium text-surface-200"
                    >Events</legend
                  >
                  <div class="flex flex-wrap gap-3">
                    {#each EVENT_OPTIONS as option (option.value)}
                      <label class="flex min-h-7 items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          value={option.value}
                          bind:group={editEvents}
                          class="checkbox"
                        />
                        <span class="text-surface-200">{option.label}</span>
                      </label>
                    {/each}
                  </div>
                </fieldset>
                {#if editError}
                  <p class="text-xs text-error-300" role="alert">
                    {editError}
                  </p>
                {/if}
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="submit"
                    disabled={editSaving}
                    class="btn preset-filled-primary-500 px-3 py-1.5 text-xs"
                  >
                    {editSaving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button
                    type="button"
                    onclick={cancelEdit}
                    class="btn preset-tonal px-3 py-1.5 text-xs"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            {/if}
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
        aria-hidden="true"
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
          rel="noreferrer"
          class="text-primary-400 hover:underline">OpenCCLaw</a
        > for automated research reports.
      </p>

      <div class="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div class="space-y-2">
          <h3 class="text-sm font-bold uppercase tracking-wider opacity-40">
            Available Events
          </h3>
          <ul class="m-0 list-none space-y-1 p-0 text-sm opacity-70">
            <li><code>article.saved</code> — When an article is bookmarked</li>
            <li>
              <code>article.ingested</code> — When a new article is discovered
            </li>
            <li><code>article.thumbs_up</code> — When an article is liked</li>
            <li><code>article.read</code> — When an article is opened/read</li>
            <li>
              <code>webhook.test</code> — Sent when you click Test on a webhook
            </li>
          </ul>
        </div>
        <div class="space-y-2">
          <h3 class="text-sm font-bold uppercase tracking-wider opacity-40">
            Request Headers
          </h3>
          <ul class="m-0 list-none space-y-1 p-0 text-sm opacity-70">
            <li><code>X-Feed-Me-Maybe-Event</code> — Event type</li>
            <li><code>X-Feed-Me-Maybe-Delivery</code> — Delivery UUID</li>
            <li>
              <code>X-Feed-Me-Maybe-Timestamp</code> — Unix timestamp (ms),
              matching payload <code>timestamp</code>
            </li>
            <li>
              <code>X-Feed-Me-Maybe-Signature</code> —
              <code>sha256=&lt;hex&gt;</code> HMAC-SHA256 of raw JSON body
            </li>
          </ul>
        </div>
      </div>

      <div class="mt-6 space-y-2">
        <h3 class="text-sm font-bold uppercase tracking-wider opacity-40">
          Payload Example
        </h3>
        <pre
          aria-label="Webhook payload example"
          class="m-0 overflow-auto rounded bg-black/30 p-3 text-xs text-primary-200 sm:text-sm"><code
            >{`{
  "type": "article.saved",
  "timestamp": 1732147200000,
  "payload": {
    "article": {
      "id": "...",
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
