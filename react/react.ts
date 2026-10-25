import { type Any, type Thenable } from "./shared.ts";

// ---- Elements --------------------------------------------------------------

/** Tags a React element. */
export const REACT_ELEMENT_TYPE: symbol = Symbol.for("react.element");
/** Tags a `React.Fragment` (`<>...</>`). */
export const REACT_FRAGMENT_TYPE: symbol = Symbol.for("react.fragment");
/** Tags a `<Suspense>` element. */
export const REACT_SUSPENSE_TYPE: symbol = Symbol.for("react.suspense");

/** `React.Fragment`: `createElement(Fragment, { children })`. */
export const Fragment: symbol = REACT_FRAGMENT_TYPE;
/** `React.Suspense`: `createElement(Suspense, { fallback, children })`. */
export const Suspense: symbol = REACT_SUSPENSE_TYPE;

export interface ReactElement {
  $$typeof: symbol;
  /** Component function, host tag (e.g. `"div"`), or a reference. */
  type: Any;
  /** Reconciliation key, or `null`. */
  key: string | null;
  /** Props, including `children`. */
  props: Record<string, Any>;
}

export function createElement(
  type: Any,
  props: Record<string, Any> | null,
  key: string | null = null,
): ReactElement {
  return { $$typeof: REACT_ELEMENT_TYPE, type, key, props: props || {} };
}

export function isValidElement(value: Any): boolean {
  return typeof value === "object" && value !== null && value.$$typeof === REACT_ELEMENT_TYPE;
}

// ---- Lazy wrappers ---------------------------------------------------------

export const REACT_LAZY_TYPE: symbol = Symbol.for("react.lazy");

export interface LazyWrapper<T = Any> {
  $$typeof: typeof REACT_LAZY_TYPE;
  /** Called on each read to return the resolved value, or throw a thenable to suspend. */
  _init: () => T;
}

export function isLazyWrapper(value: Any): value is LazyWrapper {
  return typeof value === "object" && value !== null && value.$$typeof === REACT_LAZY_TYPE;
}

export function createLazyWrapper<T>(init: () => T): LazyWrapper<T> {
  return { $$typeof: REACT_LAZY_TYPE, _init: init };
}

// ---- React.lazy ------------------------------------------------------------

/** What `lazy()` returns; usable as an element type. */
export type LazyComponent<C = Any> = LazyWrapper<C>;

export function lazy<C = Any>(load: () => Promise<{ default: C }>): LazyComponent<C> {
  let loaded: Thenable<{ default: C }> | undefined;
  return createLazyWrapper<C>(() => use((loaded ??= load())).default);
}

// ---- Client / server references --------------------------------------------

export interface ClientReferenceMeta {
  /** Bundler module identifier. */
  id: string;
  /** Export name in that module. */
  name: string;
}

export interface ServerReferenceMeta {
  /** Action identifier. */
  id: string;
}

/** Tags the object a client reference deserializes into. */
export const CLIENT_REFERENCE: unique symbol = Symbol.for("react.client.reference");
/** Tags the object a server reference deserializes into. */
export const SERVER_REFERENCE: unique symbol = Symbol.for("react.server.reference");

/** A `"use client"` export. */
export type ClientReference = ((...args: Any[]) => never) & {
  [CLIENT_REFERENCE]: ClientReferenceMeta;
};

/** A `"use server"` export. */
export type ServerReference = ((...args: Any[]) => never) & {
  [SERVER_REFERENCE]: ServerReferenceMeta;
};

export function createClientReference(moduleId: string, exportName: string): ClientReference {
  const fn = function clientReference(): never {
    throw new Error(
      "A client reference cannot be called on the server: " + moduleId + "#" + exportName,
    );
  };
  return Object.assign(fn, { [CLIENT_REFERENCE]: { id: moduleId, name: exportName } });
}

export function createServerReference(id: string): ServerReference {
  const fn = function serverReference(): never {
    throw new Error("A server reference cannot be called on the server: " + id);
  };
  return Object.assign(fn, { [SERVER_REFERENCE]: { id } });
}

/** The object an `I` row from the wire decodes into on the client. */
export interface ClientReferenceObject {
  $$typeof: symbol;
  id: string;
  name: string;
}

/** The object a `$h<id>` reference value from the wire decodes into on the client. */
export interface ServerReferenceObject {
  $$typeof: symbol;
  id: string;
}

export function isClientReference(value: Any): value is ClientReference | ClientReferenceObject {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return value.$$typeof === CLIENT_REFERENCE || value[CLIENT_REFERENCE] !== undefined;
}

export function isServerReference(value: Any): value is ServerReference | ServerReferenceObject {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return value.$$typeof === SERVER_REFERENCE || value[SERVER_REFERENCE] !== undefined;
}

export function clientReferenceMeta(
  ref: ClientReference | ClientReferenceObject,
): ClientReferenceMeta {
  return typeof ref === "function" ? ref[CLIENT_REFERENCE] : { id: ref.id, name: ref.name };
}

export function serverReferenceMeta(
  ref: ServerReference | ServerReferenceObject,
): ServerReferenceMeta {
  return typeof ref === "function" ? ref[SERVER_REFERENCE] : { id: ref.id };
}

export function clientReferenceValue(meta: ClientReferenceMeta): ClientReferenceObject {
  return { $$typeof: CLIENT_REFERENCE, id: meta.id, name: meta.name };
}

export function serverReferenceValue(id: string): ServerReferenceObject {
  return { $$typeof: SERVER_REFERENCE, id };
}

// ---- use() -----------------------------------------------------------------

/**
 * Thrown will be caught by the nearest <Suspense> component on client or
 * by the serializer on Flight server.
 */
export function use<T>(thenable: Thenable<T>): T {
  switch (thenable.status) {
    case "fulfilled":
      return thenable.value as T;
    case "rejected":
      throw thenable.reason;
  }
  if (thenable.status === undefined) {
    // Instrument it otherwise the next retry would see no status and suspend again.
    thenable.status = "pending";
    thenable.then(
      (value: T) => {
        if (thenable.status === "pending") {
          thenable.status = "fulfilled";
          thenable.value = value;
        }
      },
      (reason: Any) => {
        if (thenable.status === "pending") {
          thenable.status = "rejected";
          thenable.reason = reason;
        }
      },
    );
  }
  throw thenable;
}

// ---- Hooks -----------------------------------------------------------------
//
// The API lives here; the storage lives in the renderer.

/** Runs after the commit; may return a cleanup that runs before the next run. */
export type EffectCallback = () => void | (() => void);

/**
 * A dependency list. `undefined` means "no list", which re-runs the effect on
 * every render; a list (even an empty one) is compared item by item.
 */
export type DependencyList = unknown[];

export interface Dispatcher {
  useState<S>(initialState: S | (() => S)): [S, (action: S | ((previous: S) => S)) => void];
  useReducer<S, A>(
    reducer: (state: S, action: A) => S,
    initialArg: S,
    init?: (arg: S) => S,
  ): [S, (action: A) => void];
  useRef<T>(initialValue: T): { current: T };
  useMemo<T>(factory: () => T, deps: unknown[] | undefined): T;
  useEffect(create: EffectCallback, deps: DependencyList | undefined): void;
  useLayoutEffect(create: EffectCallback, deps: DependencyList | undefined): void;
}

export const ReactSharedInternals: { currentDispatcher: Dispatcher | null } = {
  currentDispatcher: null,
};

export function resolveDispatcher(): Dispatcher {
  const dispatcher = ReactSharedInternals.currentDispatcher;
  if (dispatcher === null) {
    throw new Error(
      "Invalid hook call. Hooks can only be called inside a function component's body.",
    );
  }
  return dispatcher;
}

export function useState<S>(
  initialState: S | (() => S),
): [S, (action: S | ((previous: S) => S)) => void] {
  return resolveDispatcher().useState(initialState);
}

export function useReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (arg: S) => S,
): [S, (action: A) => void] {
  return resolveDispatcher().useReducer(reducer, initialArg, init);
}

export function useRef<T>(initialValue: T): { current: T } {
  return resolveDispatcher().useRef(initialValue);
}

export function useMemo<T>(factory: () => T, deps: unknown[] | undefined): T {
  return resolveDispatcher().useMemo(factory, deps);
}

export function useCallback<T extends (...args: Any[]) => Any>(
  callback: T,
  deps: unknown[] | undefined,
): T {
  return useMemo(() => callback, deps);
}

/** Run after the browser can paint; a target that only serializes never runs it. */
export function useEffect(create: EffectCallback, deps?: DependencyList): void {
  resolveDispatcher().useEffect(create, deps);
}

/** Run before the browser paints, while the committed tree is readable. */
export function useLayoutEffect(create: EffectCallback, deps?: DependencyList): void {
  resolveDispatcher().useLayoutEffect(create, deps);
}
