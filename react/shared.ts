// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export interface Thenable<T = Any> extends PromiseLike<T> {
  /** Set by observer once settled; absent on a plain, uninstrumented promise. */
  status?: "pending" | "pending_weak" | "fulfilled" | "rejected";
  /** The resolved value, when `status === "fulfilled"`. */
  value?: T;
  /** The rejection reason, when `status === "rejected"`. */
  reason?: Any;
}

export function isThenable<T = Any>(value: Any): value is Thenable<T> {
  return typeof value === "object" && value !== null && typeof value.then === "function";
}
