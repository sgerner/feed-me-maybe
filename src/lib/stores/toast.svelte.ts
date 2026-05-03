// Toast notification system using Svelte 5 runes
type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;
let toasts = $state<Toast[]>([]);

export function getToasts() {
  return toasts;
}

export function addToast(message: string, type: ToastType = 'info', duration = 3000) {
  const id = nextId++;
  toasts.push({ id, message, type });
  setTimeout(() => {
    const idx = toasts.findIndex((t) => t.id === id);
    if (idx !== -1) toasts.splice(idx, 1);
  }, duration);
}