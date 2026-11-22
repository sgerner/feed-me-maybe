import { SvelteMap, SvelteSet } from 'svelte/reactivity';

type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  action?: ToastAction;
}

export type ToastAction = {
  label: string;
  run: () => void | Promise<void>;
};

let nextId = 0;
const MAX_VISIBLE_TOASTS = 2;
const toasts = $state<Toast[]>([]);
type PauseReason = 'hover' | 'focus';
type ToastTimer = {
  remainingMs: number;
  startedAt: number | null;
  timeout: ReturnType<typeof setTimeout> | null;
  pausedFor: Set<PauseReason>;
};
const toastTimers = new SvelteMap<number, ToastTimer>();
let toastSuppressed = false;

function startTimer(id: number, timer: ToastTimer) {
  if (timer.timeout || timer.pausedFor.size > 0) return;
  timer.startedAt = Date.now();
  timer.timeout = setTimeout(() => removeToast(id), timer.remainingMs);
}

export function getToasts() {
  return toasts;
}

export function removeToast(id: number) {
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index !== -1) toasts.splice(index, 1);
  const timer = toastTimers.get(id);
  if (timer?.timeout) clearTimeout(timer.timeout);
  toastTimers.delete(id);
}

export function setToastSuppressed(suppressed: boolean) {
  toastSuppressed = suppressed;
  if (suppressed) {
    for (const toast of [...toasts]) removeToast(toast.id);
  }
}

export function pauseToast(id: number, reason: PauseReason) {
  const timer = toastTimers.get(id);
  if (!timer || timer.pausedFor.has(reason)) return;
  timer.pausedFor.add(reason);
  if (timer.timeout) {
    clearTimeout(timer.timeout);
    timer.timeout = null;
    timer.remainingMs = Math.max(
      0,
      timer.remainingMs - (Date.now() - (timer.startedAt ?? Date.now())),
    );
    timer.startedAt = null;
  }
}

export function resumeToast(id: number, reason: PauseReason) {
  const timer = toastTimers.get(id);
  if (!timer || !timer.pausedFor.delete(reason)) return;
  if (timer.pausedFor.size === 0) startTimer(id, timer);
}

export function addToast(
  message: string,
  type: ToastType = 'info',
  duration = 3000,
  action?: ToastAction,
) {
  if (toastSuppressed) return;
  const id = nextId++;
  toasts.push({ id, message, type, ...(action ? { action } : {}) });
  while (toasts.length > MAX_VISIBLE_TOASTS) {
    const nonActionCandidate = toasts.find(
      (toast) => !toast.action && toast.id !== id,
    );
    removeToast((nonActionCandidate ?? toasts[0]).id);
  }

  const timer: ToastTimer = {
    remainingMs: action ? 5_000 : Math.max(0, duration),
    startedAt: null,
    timeout: null,
    pausedFor: new SvelteSet(),
  };
  toastTimers.set(id, timer);
  startTimer(id, timer);
}
