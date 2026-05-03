type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;
const toasts: Toast[] = [];
const listeners = new Set<(value: Toast[]) => void>();

function notify() {
  const snapshot = [...toasts];
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function subscribeToasts(listener: (value: Toast[]) => void) {
  listeners.add(listener);
  listener([...toasts]);

  return () => {
    listeners.delete(listener);
  };
}

export function getToasts() {
  return [...toasts];
}

export function addToast(
  message: string,
  type: ToastType = 'info',
  duration = 3000,
) {
  const id = nextId++;
  toasts.push({ id, message, type });
  notify();
  setTimeout(() => {
    const index = toasts.findIndex((toast) => toast.id === id);
    if (index !== -1) {
      toasts.splice(index, 1);
      notify();
    }
  }, duration);
}
