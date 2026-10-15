import type { StoreEvent } from './types.js';

type Listener = (event: StoreEvent) => void;

// Owns the listener set and the delivery behavior: every listener gets the
// exact same event object, and a throwing listener is swallowed, not propagated.
export class EventBus {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event: StoreEvent): void {
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* client gone */ }
    }
  }
}
