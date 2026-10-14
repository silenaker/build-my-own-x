/**
 * Shared helpers for the vitest suites.
 *
 * The Flight tests care about *when* rows are written, so the timing helpers
 * here keep the delays small and the assertions deterministic.
 */
import { createFromReadableStream, deepAwait } from "../react-flight-client.ts";
import { renderToReadableStream } from "../react-flight-server.ts";
import type { Any } from "../shared.ts";

export const sleep = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that settles after `ms`, made explicit at the call site. */
export function gate<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export interface RoundTripOptions {
  clientModules?: Record<string, Record<string, Any>>;
  resolveClientComponent?: (meta: { id: string; name: string }) => Any;
}

export interface RoundTripResult {
  value: Any;
  rows: string[];
}

/** Render a model to a Flight stream and read it back, collecting the raw rows. */
export async function roundTrip(
  model: Any,
  options: RoundTripOptions = {},
): Promise<RoundTripResult> {
  const rows: string[] = [];
  const stream = renderToReadableStream(model);
  const root = createFromReadableStream(stream, {
    ...options,
    onRow: (row) => rows.push(row),
  });
  return { value: await deepAwait(await root), rows };
}

/** The single-character type tag right after `<id>:`, e.g. `I` / `E` (or `{`). */
export function rowTag(row: string): string {
  const colon = row.indexOf(":");
  return row.slice(colon + 1, colon + 2);
}

/** Fail instead of hanging when a case never settles. */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  ms: number,
  message = "did not settle",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message + " within " + ms + "ms")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Poll until `predicate` is true; fails the test instead of hanging. */
export async function until(predicate: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met within " + ms + "ms");
    await delay(1);
  }
}
