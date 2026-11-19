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
const toasts = $state<Toast[]>([]);

export function getToasts() {
  return toasts;
}

export function removeToast(id: number) {
  const index = toasts.findIndex((toast) => toast.id === id);
  if (index !== -1) toasts.splice(index, 1);
}

export function addToast(
  message: string,
  type: ToastType = 'info',
  duration = 3000,
  action?: ToastAction,
) {
  const id = nextId++;
  toasts.push({ id, message, type, ...(action ? { action } : {}) });
  if (!action) setTimeout(() => removeToast(id), duration);
}
