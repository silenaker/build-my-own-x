/**
 * Make an object listenable: `on` / `off` / `once` / `emit`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export type Listener<Args extends Any[] = Any[]> = (...args: Args) => void;
export type EventsMap = Record<string, Listener>;
export type Unsubscribe = () => void;

export interface Listenable<Events extends EventsMap> {
  /** Subscribe. Returns the function that cancels this one subscription. */
  on<Type extends keyof Events & string>(type: Type, listener: Events[Type]): Unsubscribe;
  /** Subscribe for exactly one delivery, then unsubscribe automatically. */
  once<Type extends keyof Events & string>(type: Type, listener: Events[Type]): Unsubscribe;
  /** Unsubscribe `listener`, or every listener of `type` when it is omitted. */
  off<Type extends keyof Events & string>(type: Type, listener?: Events[Type]): void;
  /** Deliver `args` to every listener of `type`. `false` if there were none. */
  emit<Type extends keyof Events & string>(type: Type, ...args: Parameters<Events[Type]>): boolean;
  /** A copy of the current listeners of `type`. */
  listeners<Type extends keyof Events & string>(type: Type): Array<Events[Type]>;
  /** How many listeners `type` currently has. */
  listenerCount(type: keyof Events & string): number;
  /** Drop every listener, or every listener of `type`. */
  removeAllListeners(type?: keyof Events & string): void;
}

/** event name -> listeners, in registration order. */
type Store = Map<string, StoreEntry[]>;
type StoreEntry = Listener & { listener?: Listener };

const STORES = new WeakMap<object, Store>();
const INSTALLED = new WeakSet<object>();

function storeFor(target: object): Store {
  let store = STORES.get(target);
  if (store === undefined) {
    store = new Map();
    STORES.set(target, store);
  }
  return store;
}

function assertListener(listener: Any): void {
  if (typeof listener !== "function") {
    throw new TypeError(
      'The "listener" argument must be of type function. Received type ' + typeof listener,
    );
  }
}

function addListenerTo(store: Store, type: string, listener: Listener, once: boolean): Unsubscribe {
  assertListener(listener);

  let entry: StoreEntry = listener;
  if (once) {
    const wrapper: StoreEntry = (...args: Any[]) => {
      removeListenerFrom(store, type, wrapper);
      listener(...args);
    };
    // The back-pointer `off(type, originalFn)` matches on.
    wrapper.listener = listener;
    entry = wrapper;
  }

  const list = store.get(type);
  if (list === undefined) {
    store.set(type, [entry]);
  } else if (list.indexOf(entry) === -1) {
    list.push(entry);
  }

  return () => removeListenerFrom(store, type, entry);
}

function removeListenerFrom(store: Store, type: string, listener: Listener): void {
  const list = store.get(type);
  if (list === undefined) return;
  const index = list.findIndex((entry) => entry === listener || entry.listener === listener);
  if (index === -1) return;
  list.splice(index, 1);
  if (list.length === 0) store.delete(type);
}

function emitTo(store: Store, type: string, args: Any[]): boolean {
  const list = store.get(type);
  if (list === undefined || list.length === 0) return false;

  if (list.length === 1) {
    // The common case needs neither a snapshot nor a try/catch.
    list[0](...args);
    return true;
  }

  // Snapshot: a listener may unsubscribe (itself or someone else) mid-dispatch.
  const snapshot = list.slice();
  let firstError: Any;
  let didThrow = false;
  for (const entry of snapshot) {
    try {
      entry(...args);
    } catch (error) {
      if (!didThrow) {
        didThrow = true;
        firstError = error;
      } else {
        reportGlobalError(error);
      }
    }
  }
  if (didThrow) throw firstError;
  return true;
}

/**
 * Hand an error to the platform reporter, like
 * [`shared/reportGlobalError.js`](https://github.com/react/react/blob/v19.3.0/packages/shared/reportGlobalError.js).
 */
function reportGlobalError(error: Any): void {
  if (typeof reportError === "function") {
    reportError(error);
  } else {
    console.error(error);
  }
}

export class Emitter<Events extends EventsMap = EventsMap> implements Listenable<Events> {
  #listeners: Store = new Map();

  on<Type extends keyof Events & string>(type: Type, listener: Events[Type]): Unsubscribe {
    return addListenerTo(this.#listeners, type, listener, false);
  }

  once<Type extends keyof Events & string>(type: Type, listener: Events[Type]): Unsubscribe {
    return addListenerTo(this.#listeners, type, listener, true);
  }

  off<Type extends keyof Events & string>(type: Type, listener?: Events[Type]): void {
    if (listener === undefined) this.#listeners.delete(type);
    else removeListenerFrom(this.#listeners, type, listener);
  }

  emit<Type extends keyof Events & string>(type: Type, ...args: Parameters<Events[Type]>): boolean {
    return emitTo(this.#listeners, type, args);
  }

  listeners<Type extends keyof Events & string>(type: Type): Array<Events[Type]> {
    return (this.#listeners.get(type) ?? []).map(
      (entry) => (entry.listener ?? entry) as Events[Type],
    );
  }

  listenerCount(type: keyof Events & string): number {
    return this.#listeners.get(type)?.length ?? 0;
  }

  removeAllListeners(type?: keyof Events & string): void {
    if (type === undefined) this.#listeners.clear();
    else this.#listeners.delete(type);
  }
}

// ---- The mixin form: the same interface as class form but installed onto a foreign object ---

function install(target: object): void {
  if (INSTALLED.has(target)) return;
  const store = storeFor(target);

  const define = (name: string, value: Any): void => {
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      throw new TypeError(
        'Cannot make the object listenable: it already has its own "' + name + '" property.',
      );
    }
    Object.defineProperty(target, name, {
      value,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  };

  define("on", (type: string, listener: Listener) => addListenerTo(store, type, listener, false));
  define("once", (type: string, listener: Listener) => addListenerTo(store, type, listener, true));
  define("off", (type: string, listener?: Listener) => {
    if (listener === undefined) store.delete(type);
    else removeListenerFrom(store, type, listener);
  });
  define("emit", (type: string, ...args: Any[]) => emitTo(store, type, args));
  define("listeners", (type: string) =>
    (store.get(type) ?? []).map((entry) => entry.listener ?? entry),
  );
  define("listenerCount", (type: string) => store.get(type)?.length ?? 0);
  define("removeAllListeners", (type?: string) => {
    if (type === undefined) store.clear();
    else store.delete(type);
  });

  INSTALLED.add(target);
}

export function makeListenable<T extends object, Events extends EventsMap = EventsMap>(
  target: T,
): T & Listenable<Events> {
  install(target);
  return target as T & Listenable<Events>;
}

/** * A standalone emitter: shorthand for `new Emitter<Events>()`. */
export function createEmitter<Events extends EventsMap = EventsMap>(): Listenable<Events> {
  return new Emitter<Events>();
}

/** An `Emitter` instance, or a mixed-in object. */
export function isListenable(value: Any): value is Listenable<EventsMap> {
  return value instanceof Emitter || INSTALLED.has(value);
}

/** Await the arguments of the *next* delivery of event `type`. */
export function once<Events extends EventsMap, Type extends keyof Events & string>(
  emitter: Listenable<Events>,
  type: Type,
): Promise<Parameters<Events[Type]>> {
  return new Promise((resolve) => {
    emitter.once(type, ((...args: Parameters<Events[Type]>) => resolve(args)) as Events[Type]);
  });
}
