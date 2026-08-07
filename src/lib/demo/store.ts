"use client";

import type { DemoData } from "./types";
import { generateSeed } from "./seed";

const STORAGE_KEY = "meridian_demo_data_v1";
// v2 — added seeded email threads (previously WhatsApp-only), so anyone
// carrying a v1 payload in localStorage gets reseeded rather than landing on
// an empty Email tab.
const SEED_VERSION = 2;

let cache: DemoData | null = null;
const listeners = new Set<() => void>();

function freshSeed(): DemoData {
  return generateSeed();
}

function load(): DemoData {
  if (cache) return cache;
  if (typeof window === "undefined") {
    // Server-side (SSR pass of a client component's first render): return a
    // throwaway seed. Never persisted — the real store only lives in the
    // browser; components re-render client-side with the persisted copy
    // right after hydration.
    return freshSeed();
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoData;
      if (parsed.version === SEED_VERSION) {
        cache = parsed;
        return cache;
      }
    }
  } catch {
    // corrupt storage — fall through to reseed
  }
  cache = freshSeed();
  save();
  return cache;
}

function save() {
  if (!cache || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // storage full/unavailable (private browsing) — demo still works for
    // the current tab session via the in-memory cache.
  }
}

function notify() {
  save();
  listeners.forEach((l) => l());
}

/** Subscribe to any store mutation (for React components that want to
 *  re-render on change without going through a fetch). Returns an unsubscribe fn. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDb(): DemoData {
  return load();
}

/** Mutate the store via a callback, then persist + notify subscribers. */
export function mutateDb(fn: (db: DemoData) => void): DemoData {
  const db = load();
  fn(db);
  cache = db;
  notify();
  return db;
}

export function resetDemoData(): void {
  cache = freshSeed();
  save();
  listeners.forEach((l) => l());
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 7)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
