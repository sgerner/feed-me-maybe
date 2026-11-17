<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head>
  <title
    >{page.status === 404 ? 'Page not found' : 'Error'} · Feed Me Maybe</title
  >
</svelte:head>

<section class="glass-card mx-auto max-w-lg p-8 text-center">
  <p class="text-sm text-surface-300">Error {page.status}</p>
  <h1 class="section-title mt-2">
    {page.error?.message ?? 'Something went wrong'}
  </h1>
  <a
    class="btn preset-filled-primary-500 mt-6"
    href={page.status === 401 ? '/login' : '/'}
  >
    {page.status === 401 ? 'Sign in' : 'Back to reader'}
  </a>
</section>
