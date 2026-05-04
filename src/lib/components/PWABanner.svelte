<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';

  let showBanner = $state(false);
  let platform = $state<'ios' | 'android' | 'other'>('other');
  let deferredPrompt = $state<any>(null);

  onMount(() => {
    // Check if already dismissed
    const dismissed = localStorage.getItem('pwa-banner-dismissed');
    if (dismissed) return;

    // Check if already in standalone mode
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches 
      // @ts-ignore
      || window.navigator.standalone 
      || document.referrer.includes('android-app://');
    
    if (isStandalone) return;

    // Detect platform
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);

    if (isIOS) {
      platform = 'ios';
      // Wait a bit before showing on iOS to not be too intrusive
      setTimeout(() => {
        showBanner = true;
      }, 3000);
    } else if (isAndroid) {
      platform = 'android';
      window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent the mini-infobar from appearing on mobile
        e.preventDefault();
        // Stash the event so it can be triggered later.
        deferredPrompt = e;
        // Show our custom banner
        showBanner = true;
      });
    }
  });

  async function handleInstall() {
    if (platform === 'android' && deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        dismiss();
      }
      deferredPrompt = null;
    } else {
      // For iOS or if prompt is missing, just dismiss (instructions already shown)
      dismiss();
    }
  }

  function dismiss() {
    showBanner = false;
    localStorage.setItem('pwa-banner-dismissed', 'true');
  }
</script>

{#if showBanner}
  <div
    class="fixed bottom-20 left-4 right-4 z-[100] md:bottom-8 md:left-auto md:right-8 md:max-w-sm"
    transition:fly={{ y: 100, duration: 500 }}
  >
    <div class="glass-card flex flex-col gap-4 p-5 shadow-2xl">
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-3">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-500/20 text-primary-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div>
            <h3 class="text-sm font-bold text-white">Install Feed Me Maybe</h3>
            <p class="text-xs text-surface-400">Add to your home screen for the best experience.</p>
          </div>
        </div>
        <button class="btn-icon -mr-2 -mt-2 opacity-60 hover:opacity-100" onclick={dismiss} aria-label="Dismiss">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div class="rounded-sm bg-white/5 p-3 text-xs leading-relaxed text-surface-200">
        {#if platform === 'ios'}
          <p>
            Tap the <span class="mx-1 inline-flex items-center rounded bg-white/10 px-1 py-0.5"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> share button</span> in your browser's toolbar, then scroll down and select <span class="font-bold text-primary-400">"Add to Home Screen"</span>.
          </p>
        {:else if platform === 'android' && !deferredPrompt}
          <p>
            Tap the <span class="mx-1 inline-flex items-center rounded bg-white/10 px-1 py-0.5"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg> menu icon</span> and select <span class="font-bold text-primary-400">"Install app"</span> or <span class="font-bold text-primary-400">"Add to Home screen"</span>.
          </p>
        {:else if platform === 'android' && deferredPrompt}
          <p>Click the button below to install the app directly on your device.</p>
        {:else}
          <p>Open your browser menu and select <span class="font-bold text-primary-400">"Install"</span> or <span class="font-bold text-primary-400">"Add to Home screen"</span>.</p>
        {/if}
      </div>

      <button class="btn preset-filled-primary-500 w-full text-xs font-bold" onclick={handleInstall}>
        {#if platform === 'android' && deferredPrompt}
          Install Now
        {:else}
          Got it
        {/if}
      </button>
    </div>
  </div>
{/if}
