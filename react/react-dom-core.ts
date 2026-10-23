import {
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_SUSPENSE_TYPE,
  ReactSharedInternals,
  isClientReference,
  isLazyWrapper,
  isServerReference,
  type Dispatcher,
  type LazyWrapper,
} from "./react.ts";
import { isThenable, type Any, type Thenable } from "./shared.ts";

export interface NormalizedProperties {
  /** `[attributeName, value]`, already stringified. */
  attributes: Array<[string, string]>;
  /** `[eventType, listener]`, e.g. `["click", onClick]`. */
  events: Array<[string, Any]>;
  /** Raw HTML from `dangerouslySetInnerHTML`, or `null` when children are used. */
  innerHTML: string | null;
}

/** Host seam: `Root` is the container, `Instance` is one node in it. */
export interface HostConfig<Root, Instance> {
  createRoot(): Root;
  createInstance(type: string): Instance;
  createTextInstance(text: string): Instance;
  appendChild(parent: Root | Instance, child: Instance): void;
  setInitialProperties(instance: Instance, properties: NormalizedProperties): void;
  setInnerHTML(instance: Instance, html: string): void;
  /** A detached parent, so a boundary keeps its output out of the tree until it is whole. */
  createStagingRoot(): Root | Instance;
  /** Move everything staged into `parent`, right before `reference` when one is given. */
  commitStaged(parent: Root | Instance, staged: Root | Instance, reference?: Instance | null): void;
  /** Remove every child of `parent` strictly between two boundary markers. */
  clearBetween(parent: Root | Instance, start: Instance, end: Instance): void;
  /** Fizz markers live in comments, so every target has to be able to make one. */
  createCommentInstance(text: string): Instance;
  /** Rewrite a marker once the boundary's outcome is known. */
  setCommentText(instance: Instance, text: string): void;
  /** Read a marker's data; a retry checks whether the server revealed content. */
  getCommentText(instance: Instance): string;
  /** Set only on targets whose containers may already hold server markup. */
  hydration?: HydrationConfig<Root, Instance> | null;
}

/** One server node a hydrating container still has to match. */
export interface HydrationNode<Instance> {
  instance: Instance;
  kind: "element" | "text" | "comment" | "other";
  /** Tag name for elements, the data for text and comment nodes. */
  value: string;
}

/**
 * Reuse is positional: the walker asks each container for its next unclaimed
 * node, and the host knows where that node is and whether it is still there.
 */
export interface HydrationConfig<Root, Instance> {
  /** Start a pass over the children `root` already holds. */
  begin(root: Root): void;
  /** The next unclaimed child of `parent`, or `null` once the markup runs out. */
  next(parent: Root | Instance): HydrationNode<Instance> | null;
  /** Keep the node at the cursor; the walker matched it. */
  accept(parent: Root | Instance, node: HydrationNode<Instance>): void;
  /** Leave the node in place but advance past it; a deferred boundary keeps its markup. */
  skip(parent: Root | Instance, node: HydrationNode<Instance>): void;
  /** Remove the node at the cursor; the walker cannot use it. */
  drop(parent: Root | Instance, node: HydrationNode<Instance>): void;
  /** Remove what the pass never claimed, then forget its cursors. */
  finish(root: Root): void;
  /** Drop every child of `root`, so the client can render from scratch. */
  clear(root: Root): void;
  /** Re-enter hydration of one container, starting after `marker`. */
  beginScope(parent: Root | Instance, marker: Instance): void;
  /** End a scoped pass; nodes it did not claim stay where they are. */
  endScope(): void;
}

/**
 * A server target that keeps suspended boundaries alive so it can write their
 * content after the shell. `null` on targets that cannot wait.
 */
export interface BoundaryTracker<Root, Instance> {
  /** The boundary whose content is being rendered, or `null` at the shell. */
  parent: number | null;
  /** The same boundary keeps its id when a pass renders it again. */
  idFor(key: string): number;
  /** The id the browser looks up, including any configured prefix. */
  templateId(id: number): string;
  /** The children suspended; `retry` renders them into a detached root. */
  postpone(id: number, thenable: Thenable, retry: () => Root | Instance): void;
  /** The boundary's content is in the document; nothing is owed for it. */
  finish(id: number): void;
}

// ---- Component instances and the hook dispatcher ---------------------------

/** One hook's slot on a component instance. */
interface HookSlot {
  /** Set once the hook has run for the first time (mount). */
  mounted: boolean;
  /** `useState` / `useReducer`: the current value and the actions queued since. */
  state?: Any;
  queue?: Any[];
  dispatch?: (action: Any) => void;
  /** `useRef`: the (stable) ref object. */
  ref?: { current: Any };
  /** `useMemo` / `useCallback`: the memoized value and the deps it was based on. */
  memoized?: Any;
  deps?: unknown[];
}

interface ComponentInstance {
  hooks: HookSlot[];
  /** Ordinal of the next hook call. */
  hookIndex: number;
  /** Re-render the root. */
  rerender: () => void;
  /** The component the hooks belong to; another one at the same slot mounts fresh. */
  type: Any;
  /** Distinguishes one mounted instance from the next one at the same slot. */
  id: number;
}

let currentInstance: ComponentInstance | null = null;

/** Identifies one mounted instance, so its output subtree keeps a stable scope. */
let nextInstanceId = 0;

function requireInstance(): ComponentInstance {
  if (currentInstance === null) {
    throw new Error("Invalid hook call. Hooks can only be called inside a component's body.");
  }
  return currentInstance;
}

/** Take the next hook slot of the component being rendered. */
function nextHook(): HookSlot {
  const instance = requireInstance();
  const index = instance.hookIndex++;
  let hook = instance.hooks[index];
  if (hook === undefined) {
    hook = { mounted: false };
    instance.hooks.push(hook);
  }
  return hook;
}

function readState<S>(
  initialState: S | (() => S),
): [S, (action: S | ((previous: S) => S)) => void] {
  const instance = requireInstance();
  const hook = nextHook();

  if (!hook.mounted) {
    hook.mounted = true;
    hook.state = typeof initialState === "function" ? (initialState as () => S)() : initialState;
    hook.queue = [];
  }

  // Apply every action queued since the last render.
  const queue = hook.queue as Any[];
  if (queue.length > 0) {
    let state = hook.state as S;
    for (const action of queue) {
      state = typeof action === "function" ? (action as (previous: S) => S)(state) : (action as S);
    }
    hook.state = state;
    queue.length = 0;
  }

  if (hook.dispatch === undefined) {
    hook.dispatch = (action: Any) => {
      queue.push(action);
      instance.rerender();
    };
  }

  return [hook.state as S, hook.dispatch as (action: S | ((previous: S) => S)) => void];
}

function readReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (arg: S) => S,
): [S, (action: A) => void] {
  const instance = requireInstance();
  const hook = nextHook();

  if (!hook.mounted) {
    hook.mounted = true;
    hook.state = init !== undefined ? init(initialArg) : initialArg;
    hook.queue = [];
  }

  const queue = hook.queue as A[];
  if (queue.length > 0) {
    let state = hook.state as S;
    for (const action of queue) state = reducer(state, action);
    hook.state = state;
    queue.length = 0;
  }

  if (hook.dispatch === undefined) {
    hook.dispatch = (action: A) => {
      queue.push(action);
      instance.rerender();
    };
  }

  return [hook.state as S, hook.dispatch as (action: A) => void];
}

function readRef<T>(initialValue: T): { current: T } {
  const hook = nextHook();
  if (!hook.mounted) {
    hook.mounted = true;
    hook.ref = { current: initialValue };
  }
  return hook.ref as { current: T };
}

function readMemo<T>(factory: () => T, deps: unknown[] | undefined): T {
  const hook = nextHook();
  if (!hook.mounted || !areDepsEqual(hook.deps, deps)) {
    hook.mounted = true;
    hook.memoized = factory();
    hook.deps = deps === undefined ? undefined : deps.slice();
  }
  return hook.memoized as T;
}

/** Shallow compare by `Object.is`. */
function areDepsEqual(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i++) {
    if (!Object.is(previous[i], next[i])) return false;
  }
  return true;
}

const hookDispatcher: Dispatcher = {
  useState: readState,
  useReducer: readReducer,
  useRef: readRef,
  useMemo: readMemo,
};

const noop = (): void => {};

// ---- The element walker ----------------------------------------------------

/**
 * One container the walker fills: the root, a host element, a component, or a
 * boundary's content or fallback. The key is the path to that container, so a
 * replaced ancestor renames the whole subtree and its instances go with it.
 */
interface RenderScope {
  /** Path from the root to this container; prefixes every key below it. */
  key: string;
  /** Ordinal of the next child here; every child consumes one. */
  index: number;
}

interface RenderContext<Root, Instance> {
  host: HostConfig<Root, Instance>;
  /** Component instances by their path from the root. */
  instances: Map<string, ComponentInstance>;
  /** Instance keys reached in this pass, including an attempt that suspended. */
  rendered: Set<string>;
  /** The container being filled right now; its key prefixes every key inside it. */
  scope: RenderScope;
  /** Re-render the root (a no-op for the HTML target). */
  rerender: () => void;
  /**
   * A boundary is waiting on this thenable. `retry` re-renders just that
   * boundary (or the root, when the boundary was never in server markup).
   */
  onSuspend: (thenable: Thenable, retry: () => void) => void;
  /** Set only by server targets that can complete a boundary later. */
  boundaries: BoundaryTracker<Root, Instance> | null;
  /** Report an error a boundary swallowed, without failing the whole tree. */
  onError?: (error: Any) => void;
  /** Set only while a pass reuses markup instead of creating nodes. */
  hydrating: boolean;
  hydration: HydrationConfig<Root, Instance> | null;
  /** Thenables found mid-hydration; they are reported only after the pass ends. */
  deferred: DeferredSuspension[] | null;
  /** Host properties claimed by a hydrating pass, applied only if it commits. */
  pendingProps: PendingProperties<Instance>[] | null;
  /** Full passes so far, so a retry armed by an old tree cannot touch a newer one. */
  pass: number;
}

interface DeferredSuspension {
  thenable: Thenable;
  retry: () => void;
  /** The content scope that armed the retry, so a later replacement can drop it. */
  key: string;
}

interface PendingProperties<Instance> {
  instance: Instance;
  properties: NormalizedProperties;
  /** The element's path, so a suspended attempt drops only its own work. */
  key: string;
}

/** The element tree and the server markup cannot be lined up node for node. */
class HydrationMismatchError extends Error {}

function renderPass<Root, Instance>(
  context: RenderContext<Root, Instance>,
  element: Any,
  parent: Root | Instance,
): void {
  context.pass++;
  context.scope = { key: "root", index: 0 };
  context.rendered.clear();
  if (context.boundaries !== null) context.boundaries.parent = null;
  try {
    renderNode(context, element, parent);
  } catch (thrown) {
    // No enclosing boundary can show a fallback, so the tree has to be settled
    // before it is rendered again.
    if (isThenable(thrown)) {
      throw new Error(
        "A component suspended while rendering synchronously, but no <Suspense> boundary " +
          "was found. Await the tree first (e.g. `await deepAwait(root)`) before rendering it.",
      );
    }
    throw thrown;
  }
  // A component missing from this pass was unmounted, so its hooks must not
  // leak into whichever component later occupies the same path.
  for (const key of context.instances.keys()) {
    if (!context.rendered.has(key)) context.instances.delete(key);
  }
}

/** Run `render` with a fresh child scope named `key`. */
function renderInScope<Root, Instance>(
  context: RenderContext<Root, Instance>,
  key: string,
  render: () => void,
): void {
  const outer = context.scope;
  context.scope = { key, index: 0 };
  try {
    render();
  } finally {
    context.scope = outer;
  }
}

function getInstance<Root, Instance>(
  context: RenderContext<Root, Instance>,
  type: Any,
  segment: string,
): ComponentInstance {
  const key = context.scope.key + "/" + segment;
  context.rendered.add(key);
  let instance = context.instances.get(key);
  if (instance !== undefined && instance.type !== type) {
    // Another component took this slot, so the old hooks cannot carry over.
    instance = undefined;
  }
  if (instance === undefined) {
    instance = {
      type,
      id: nextInstanceId++,
      hooks: [],
      hookIndex: 0,
      rerender: context.rerender,
    };
    context.instances.set(key, instance);
  }
  return instance;
}

function renderNode<Root, Instance>(
  context: RenderContext<Root, Instance>,
  value: Any,
  parent: Root | Instance,
): void {
  // A lazy wrapper can also appear as a child, not only as an element's `type`.
  let node: Any = value;
  while (isLazyWrapper(node)) {
    node = resolveLazy(node);
  }

  // Arrays flatten into the parent, so they take no slot of their own.
  if (Array.isArray(node)) {
    for (const child of node) renderNode(context, child, parent);
    return;
  }

  const index = context.scope.index++;
  if (node === null || node === undefined || typeof node === "boolean") return;

  switch (typeof node) {
    case "string":
      renderText(context, parent, node);
      return;
    case "number":
      renderText(context, parent, "" + node);
      return;
    case "bigint":
      renderText(context, parent, String(node));
      return;
    case "symbol":
      throw new Error("Symbols are not valid as a React child.");
    case "function":
      throw new Error("Functions are not valid as a React child.");
  }

  if (node.$$typeof === REACT_ELEMENT_TYPE) {
    renderElement(context, node, index, parent);
    return;
  }
  throw new Error("Objects are not valid as a React child (found: " + describe(node) + ").");
}

/** Text either becomes a node or has to match the one the server left behind. */
function renderText<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
  text: string,
): void {
  if (!context.hydrating) {
    context.host.appendChild(parent, context.host.createTextInstance(text));
    return;
  }
  if (claimNode(context, parent, "text").value !== text) {
    // A different string means every following node is out of alignment too.
    throw new HydrationMismatchError();
  }
}

/** Take the next server node when it has the expected kind, or abandon hydration. */
function claimNode<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
  kind: "element" | "text" | "comment",
): HydrationNode<Instance> {
  const hydration = context.hydration;
  const node = hydration === null ? null : hydration.next(parent);
  if (hydration === null || node === null || node.kind !== kind) {
    throw new HydrationMismatchError();
  }
  hydration.accept(parent, node);
  return node;
}

/** A child's identity among its siblings: its key, or its ordinal when unkeyed. */
function childSegment(element: Any, index: number): string {
  const key = element.key;
  return key === null || key === undefined ? "#" + index : "$" + key;
}

function renderElement<Root, Instance>(
  context: RenderContext<Root, Instance>,
  element: Any,
  index: number,
  parent: Root | Instance,
): void {
  const props: Any = element.props ?? {};
  let type: Any = element.type;

  // A lazy wrapper `type` can resolve to a component or a deeper lazy wrapper.
  while (isLazyWrapper(type)) {
    type = resolveLazy(type);
  }

  const segment = childSegment(element, index);

  if (type === REACT_FRAGMENT_TYPE) {
    // A fragment is a level of its own, so its children are numbered inside it.
    renderInScope(context, context.scope.key + "/Fragment" + segment, () => {
      renderNode(context, props.children, parent);
    });
    return;
  }
  if (type === REACT_SUSPENSE_TYPE) {
    renderSuspense(context, props, segment, parent);
    return;
  }
  if (typeof type === "string") {
    renderHostElement(context, type, props, segment, parent);
    return;
  }

  if (typeof type === "function") {
    renderComponent(context, type, props, segment, parent);
    return;
  }
  throw new Error(
    "Element type is invalid: expected a string (a host tag) or a function (a component) but got: " +
      describe(type) +
      ".",
  );
}

function renderHostElement<Root, Instance>(
  context: RenderContext<Root, Instance>,
  tag: string,
  props: Any,
  segment: string,
  parent: Root | Instance,
): void {
  const properties = normalizeProperties(props);
  let instance: Instance;
  if (context.hydrating) {
    const node = claimNode(context, parent, "element");
    if (node.value !== tag) throw new HydrationMismatchError();
    instance = node.instance;
  } else {
    instance = context.host.createInstance(tag);
  }

  // The tag is part of the path, so replacing this element remounts its children.
  const elementKey = context.scope.key + "/" + tag + segment;
  renderInScope(context, elementKey, () => {
    if (properties.innerHTML !== null) {
      // `dangerouslySetInnerHTML` wins over children.
      // Hydration trusts the server's HTML, so it stays untouched.
      if (!context.hydrating) context.host.setInnerHTML(instance, properties.innerHTML);
    } else {
      renderNode(context, props.children, instance);
    }
  });

  if (context.hydrating) {
    // Applied only if the attempt commits, so a retry cannot bind listeners twice.
    context.pendingProps?.push({ instance, properties, key: elementKey });
    return;
  }
  context.host.setInitialProperties(instance, properties);
  context.host.appendChild(parent, instance);
}

function renderComponent<Root, Instance>(
  context: RenderContext<Root, Instance>,
  component: Any,
  props: Any,
  segment: string,
  parent: Root | Instance,
): void {
  if (typeof component !== "function") {
    throw new Error("Expected a component function, but got: " + describe(component) + ".");
  }

  const instance = getInstance(context, component, segment);
  const previousDispatcher = ReactSharedInternals.currentDispatcher;
  const previousInstance = currentInstance;

  currentInstance = instance;
  instance.hookIndex = 0;
  ReactSharedInternals.currentDispatcher = hookDispatcher;

  let output: Any;
  try {
    output = component(props);
  } finally {
    ReactSharedInternals.currentDispatcher = previousDispatcher;
    currentInstance = previousInstance;
  }

  if (instance.hookIndex < instance.hooks.length) {
    throw new Error(
      "Rendered fewer hooks than expected. This is probably caused by an early return statement.",
    );
  }

  renderInScope(context, context.scope.key + "/" + segment + "@" + instance.id, () => {
    renderNode(context, output, parent);
  });
}

// ---- Suspense boundaries ---------------------------------------------------

/**
 * Children render into a staging root, so a subtree that suspends halfway
 * leaves no trace. The fallback takes its place until the root is retried.
 */
function renderSuspense<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  segment: string,
  parent: Root | Instance,
): void {
  const boundaryKey = context.scope.key + "/Suspense" + segment;
  const contentKey = boundaryKey + ":content";
  const fallbackKey = boundaryKey + ":fallback";

  if (context.hydrating) {
    hydrateSuspense(context, props, contentKey, fallbackKey, parent);
    return;
  }

  const tracker = context.boundaries;
  if (tracker === null) {
    renderSuspenseContent(context, props, contentKey, fallbackKey, parent);
    return;
  }

  const id = tracker.idFor(boundaryKey);

  // The start marker is written before the outcome is known, so a suspension
  // can turn it into `$?` without moving what precedes it.
  const start = context.host.createCommentInstance("$");
  context.host.appendChild(parent, start);

  let staged: Root | Instance;
  try {
    staged = renderBoundaryChildren(context, props.children, contentKey, id);
  } catch (thrown) {
    retainScope(context, contentKey);

    if (isThenable(thrown)) {
      context.host.setCommentText(start, "$?");
      context.host.appendChild(parent, createBoundaryTemplate(context, id, null));
      renderBoundaryFallback(context, props.fallback, fallbackKey, parent);
      context.host.appendChild(parent, context.host.createCommentInstance("/$"));
      tracker.postpone(id, thrown, () =>
        renderBoundaryChildren(context, props.children, contentKey, id),
      );
    } else {
      // The boundary cannot recover on the client either, so its fallback is
      // the final output and the error only goes to `onError`.
      context.host.setCommentText(start, "$!");
      context.host.appendChild(parent, createBoundaryTemplate(context, id, thrown));
      renderBoundaryFallback(context, props.fallback, fallbackKey, parent);
      context.host.appendChild(parent, context.host.createCommentInstance("/$"));
      context.onError?.(thrown);
      tracker.finish(id);
    }
    return;
  }

  context.host.commitStaged(parent, staged);
  context.host.appendChild(parent, context.host.createCommentInstance("/$"));
  tracker.finish(id);
}

/** The client path: no markers, and a suspension leaves the fallback in place. */
function renderSuspenseContent<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
): void {
  let staged: Root | Instance;
  try {
    staged = renderBoundaryChildren(context, props.children, contentKey, 0);
  } catch (thrown) {
    if (!isThenable(thrown)) throw thrown;
    retainScope(context, contentKey);
    renderBoundaryFallback(context, props.fallback, fallbackKey, parent);
    // Without markers there is no range to replace, so the root is the unit.
    suspend(context, thrown, context.rerender, contentKey);
    return;
  }
  context.host.commitStaged(parent, staged);
}

/** Render the boundary's children into a detached root, naming `id` as their parent. */
function renderBoundaryChildren<Root, Instance>(
  context: RenderContext<Root, Instance>,
  children: Any,
  contentKey: string,
  id: number,
): Root | Instance {
  const tracker = context.boundaries;
  const previous = tracker === null ? null : tracker.parent;
  if (tracker !== null) tracker.parent = id;
  try {
    const staged = context.host.createStagingRoot();
    renderInScope(context, contentKey, () => {
      renderNode(context, children, staged);
    });
    return staged;
  } finally {
    if (tracker !== null) tracker.parent = previous;
  }
}

/** Fallbacks are already in the document, so a boundary inside one can stream at once. */
function renderBoundaryFallback<Root, Instance>(
  context: RenderContext<Root, Instance>,
  fallback: Any,
  fallbackKey: string,
  parent: Root | Instance,
): void {
  const tracker = context.boundaries;
  const previous = tracker === null ? null : tracker.parent;
  if (tracker !== null) tracker.parent = null;
  try {
    const staged = context.host.createStagingRoot();
    renderInScope(context, fallbackKey, () => {
      renderNode(context, fallback, staged);
    });
    context.host.commitStaged(parent, staged);
  } finally {
    if (tracker !== null) tracker.parent = previous;
  }
}

/** The `<template id>` the reveal script targets. */
function createBoundaryTemplate<Root, Instance>(
  context: RenderContext<Root, Instance>,
  id: number,
  error: Any,
): Instance {
  const template = context.host.createInstance("template");
  const attributes: Array<[string, string]> = [
    ["id", context.boundaries === null ? "B" + id : context.boundaries.templateId(id)],
  ];
  if (error !== null) {
    attributes.push(["data-dgst", ""]);
    attributes.push(["data-msg", error instanceof Error ? error.message : String(error)]);
  }
  context.host.setInitialProperties(template, { attributes, events: [], innerHTML: null });
  return template;
}

/** Keep every instance mounted before an attempt that suspended, so the retry reuses it. */
function retainScope<Root, Instance>(
  context: RenderContext<Root, Instance>,
  scopeKey: string,
): void {
  const prefix = scopeKey + "/";
  for (const key of context.instances.keys()) {
    if (key.startsWith(prefix)) context.rendered.add(key);
  }
}

// ---- Suspension bookkeeping ------------------------------------------------

/**
 * Report a suspension to the host. Hydration collects them instead, because a
 * synchronous settlement would otherwise re-enter the walk that is still
 * claiming nodes.
 */
function suspend<Root, Instance>(
  context: RenderContext<Root, Instance>,
  thenable: Thenable,
  retry: () => void,
  key: string,
): void {
  if (context.deferred !== null) context.deferred.push({ thenable, retry, key });
  else context.onSuspend(thenable, retry);
}

/** Keep the server markup and retry this boundary when `thenable` settles. */
function suspendBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  contentKey: string,
  thenable: Thenable,
  retry: () => void,
): void {
  retainScope(context, contentKey);
  const pass = context.pass;
  suspend(
    context,
    thenable,
    () => {
      /** A retry only runs while the tree that armed it is still the current one. */
      if (context.pass === pass) retry();
    },
    contentKey,
  );
}

/** Forget retries armed by a subtree that is about to be replaced wholesale. */
function dropDeferred<Root, Instance>(context: RenderContext<Root, Instance>, key: string): void {
  const deferred = context.deferred;
  if (deferred === null) return;
  const prefix = key + "/";
  for (let i = deferred.length - 1; i >= 0; i--) {
    const armed = deferred[i].key;
    if (armed === key || armed.startsWith(prefix)) deferred.splice(i, 1);
  }
}

/** Apply the host work of an attempt that committed. */
function applyPendingProperties<Root, Instance>(
  context: RenderContext<Root, Instance>,
  queued: PendingProperties<Instance>[],
): void {
  for (const { instance, properties } of queued) {
    context.host.setInitialProperties(instance, properties);
  }
}

/** Drop the host work of an attempt that suspended or mismatched. */
function dropPendingProps<Root, Instance>(
  context: RenderContext<Root, Instance>,
  key: string,
): void {
  const queued = context.pendingProps;
  if (queued === null) return;
  const prefix = key + "/";
  for (let i = queued.length - 1; i >= 0; i--) {
    if (queued[i].key.startsWith(prefix)) queued.splice(i, 1);
  }
}

// ---- Hydrating a boundary --------------------------------------------------

/** What one scoped hydration attempt achieved. */
type BoundaryAttempt<Instance> =
  | { status: "hydrated"; queued: PendingProperties<Instance>[] }
  | { status: "suspended"; thenable: Thenable }
  | { status: "mismatched" };

/** What rendering the content detached from the document achieved. */
type ContentProbe<Root, Instance> =
  | { status: "ready"; staged: Root | Instance }
  | { status: "suspended"; thenable: Thenable }
  | { status: "threw"; error: Any };

/**
 * Server markup for a boundary has three shapes: content (`$`), a placeholder
 * (`$?`/`$~`), or a permanent fallback (`$!`). `renderToString` writes no
 * markers, so its content sits directly in the parent.
 */
function hydrateSuspense<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
): void {
  const marker = peekMarker(context, parent);

  switch (marker) {
    case null:
      try {
        renderInScope(context, contentKey, () => {
          renderNode(context, props.children, parent);
        });
      } catch (thrown) {
        if (thrown instanceof HydrationMismatchError) throw thrown;
        throw new HydrationMismatchError();
      }
      return;
    case "$":
      hydrateCompletedBoundary(context, props, contentKey, fallbackKey, parent);
      return;
    case "$?":
    case "$~":
      hydratePostponedBoundary(context, props, contentKey, fallbackKey, parent, marker);
      return;
    case "$!":
      hydrateFailedBoundary(context, props, contentKey, fallbackKey, parent);
      return;
    default:
      throw new HydrationMismatchError();
  }
}

/** The server rendered the content; hydrate it, or keep it for a later retry. */
function hydrateCompletedBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
): void {
  const start = acceptMarker(context, parent, "$");
  try {
    renderInScope(context, contentKey, () => {
      renderNode(context, props.children, parent);
    });
    acceptMarker(context, parent, "/$");
  } catch (thrown) {
    dropPendingProps(context, contentKey);
    skipUntilEndMarker(context, parent);
    const end = acceptMarker(context, parent, "/$");
    // A suspension is not a mismatch: the server's content is the right
    // content, the client just cannot hydrate it yet.
    if (isThenable(thrown)) {
      suspendBoundary(context, contentKey, thrown, () =>
        retryBoundaryHydration(context, props, contentKey, fallbackKey, parent, start, end),
      );
      return;
    }
    clientRenderBoundary(context, props, contentKey, fallbackKey, parent, start, end);
  }
}

/**
 * The server never sent this content. A detached attempt learns what the
 * boundary is waiting for, while the server's fallback stays untouched.
 */
function hydratePostponedBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
  marker: string,
): void {
  const start = acceptMarker(context, parent, marker);
  skipElement(context, parent, "template");
  skipUntilEndMarker(context, parent);
  const end = acceptMarker(context, parent, "/$");

  const probe = probeBoundaryContent(context, props.children, contentKey);
  if (probe.status === "suspended") {
    // The fallback is already on screen; only the content is missing. If Fizz
    // revealed content in the meantime, hydration is still preferable.
    suspendBoundary(context, contentKey, probe.thenable, () =>
      retryBoundaryHydration(context, props, contentKey, fallbackKey, parent, start, end),
    );
    return;
  }
  if (probe.status === "threw") throw probe.error;

  // The client already has the content, so replace the server's placeholder.
  commitBoundaryRange(context, parent, start, end, probe.staged);
}

/** `$!` means the server gave up; React retries that boundary on the client. */
function hydrateFailedBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
): void {
  const start = acceptMarker(context, parent, "$!");
  skipElement(context, parent, "template");
  skipUntilEndMarker(context, parent);
  const end = acceptMarker(context, parent, "/$");
  clientRenderBoundary(context, props, contentKey, fallbackKey, parent, start, end);
}

/**
 * Client-render one boundary between its markers. The rest of the hydrated
 * tree is untouched, so a late settlement never rebuilds the root. The
 * markers stay so a later retry can replace the same range again.
 */
function clientRenderBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
  start: Instance,
  end: Instance,
): void {
  const wasHydrating = context.hydrating;
  context.hydrating = false;
  // The subtree is rebuilt, so retries armed by the version being replaced are void.
  dropDeferred(context, contentKey);
  try {
    const probe = probeBoundaryContent(context, props.children, contentKey);
    if (probe.status === "ready") {
      commitBoundaryRange(context, parent, start, end, probe.staged);
      return;
    }
    if (probe.status === "threw") throw probe.error;

    // The content is not ready, so the fallback fills the range until it is.
    const fallback = context.host.createStagingRoot();
    renderInScope(context, fallbackKey, () => {
      renderNode(context, props.fallback, fallback);
    });
    commitBoundaryRange(context, parent, start, end, fallback);
    // Last, so a synchronous settlement cannot re-enter this frame.
    suspendBoundary(context, contentKey, probe.thenable, () =>
      clientRenderBoundary(context, props, contentKey, fallbackKey, parent, start, end),
    );
  } finally {
    context.hydrating = wasHydrating;
  }
}

/** Render the content detached, so an attempt can be thrown away untouched. */
function probeBoundaryContent<Root, Instance>(
  context: RenderContext<Root, Instance>,
  children: Any,
  contentKey: string,
): ContentProbe<Root, Instance> {
  const wasHydrating = context.hydrating;
  context.hydrating = false;
  try {
    const staged = renderBoundaryChildren(context, children, contentKey, 0);
    return { status: "ready", staged };
  } catch (thrown) {
    if (isThenable(thrown)) return { status: "suspended", thenable: thrown };
    return { status: "threw", error: thrown };
  } finally {
    context.hydrating = wasHydrating;
  }
}

/**
 * Claim a boundary's content again, starting after its start marker. The DOM
 * is read fresh, so content Fizz revealed after the first pass is included.
 */
function attemptBoundaryHydration<Root, Instance>(
  context: RenderContext<Root, Instance>,
  children: Any,
  contentKey: string,
  parent: Root | Instance,
  start: Instance,
): BoundaryAttempt<Instance> {
  const hydration = context.hydration;
  if (hydration === null) return { status: "mismatched" };

  hydration.beginScope(parent, start);
  const queued: PendingProperties<Instance>[] = [];
  const wasHydrating = context.hydrating;
  const wasPending = context.pendingProps;
  context.hydrating = true;
  context.pendingProps = queued;
  try {
    try {
      renderInScope(context, contentKey, () => {
        renderNode(context, children, parent);
      });
      acceptMarker(context, parent, "/$");
      return { status: "hydrated", queued };
    } catch (thrown) {
      // A wakeable only means the data is late; anything else is a mismatch.
      if (isThenable(thrown)) return { status: "suspended", thenable: thrown };
      return { status: "mismatched" };
    }
  } finally {
    context.hydrating = wasHydrating;
    context.pendingProps = wasPending;
    hydration.endScope();
  }
}

/**
 * Retry a boundary whose server content is still on screen. Hydration is
 * re-entered in place; only content that cannot match the markup is rebuilt.
 */
function retryBoundaryHydration<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
  start: Instance,
  end: Instance,
): void {
  if (context.hydration !== null && context.host.getCommentText(start) === "$") {
    const attempt = attemptBoundaryHydration(context, props.children, contentKey, parent, start);
    if (attempt.status === "hydrated") {
      applyPendingProperties(context, attempt.queued);
      return;
    }
    if (attempt.status === "suspended") {
      // Still not ready. The markup is untouched, so try hydration again later.
      suspendBoundary(context, contentKey, attempt.thenable, () =>
        retryBoundaryHydration(context, props, contentKey, fallbackKey, parent, start, end),
      );
      return;
    }
  }

  // Either there is no markup to reuse (`$?`/`$~`) or hydration cannot match
  // what the server sent, so only a client render can settle this boundary.
  clientRenderBoundary(context, props, contentKey, fallbackKey, parent, start, end);
}

/** Replace whatever sits between a boundary's markers with `staged`. */
function commitBoundaryRange<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
  start: Instance,
  end: Instance,
  staged: Root | Instance,
): void {
  context.host.clearBetween(parent, start, end);
  context.host.commitStaged(parent, staged, end);
}

// ---- Hydration markers -----------------------------------------------------

function peekMarker<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
): string | null {
  const hydration = context.hydration;
  const node = hydration === null ? null : hydration.next(parent);
  return node !== null && node.kind === "comment" ? node.value : null;
}

function acceptMarker<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
  value: string,
): Instance {
  const hydration = context.hydration;
  const node = hydration === null ? null : hydration.next(parent);
  if (hydration === null || node === null || node.kind !== "comment" || node.value !== value) {
    throw new HydrationMismatchError();
  }
  hydration.accept(parent, node);
  return node.instance;
}

/** Leave a node where the server put it and step over it. */
function skipElement<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
  tag: string,
): void {
  const hydration = context.hydration;
  const node = hydration === null ? null : hydration.next(parent);
  if (hydration === null || node === null || node.kind !== "element" || node.value !== tag) {
    throw new HydrationMismatchError();
  }
  hydration.skip(parent, node);
}

/** Advance to the boundary's end marker without touching the nodes it skips. */
function skipUntilEndMarker<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
): void {
  const hydration = context.hydration;
  if (hydration === null) throw new HydrationMismatchError();

  let depth = 0;
  for (let node = hydration.next(parent); node !== null; node = hydration.next(parent)) {
    if (node.kind === "comment") {
      if (node.value === "/$") {
        if (depth === 0) return;
        depth--;
        hydration.skip(parent, node);
        continue;
      }
      if (isBoundaryStart(node.value)) depth++;
    }
    hydration.skip(parent, node);
  }
  throw new HydrationMismatchError();
}

function isBoundaryStart(data: string): boolean {
  return data === "$" || data === "$?" || data === "$~" || data === "$!";
}

// ---- The public renderer ---------------------------------------------------

export interface RendererOptions<Root, Instance> {
  /** Set only by server targets that can complete a boundary later. */
  boundaries?: BoundaryTracker<Root, Instance> | null;
  /** Report an error a boundary swallowed, without failing the whole tree. */
  onError?: (error: Any) => void;
  /** Re-render the root after a state update; the DOM target supplies one. */
  rerender?: () => void;
  /** A boundary suspended; `retry` re-renders the boundary (or the root) later. */
  onSuspend?: (thenable: Thenable, retry: () => void) => void;
}

/** One host-bound walker. Every pass reuses the hook instances it mounted. */
export interface Renderer<Root> {
  /** Fill a fresh root with `element`. */
  render(element: Any): Root;
  /** Fill `root`, reusing the markup its host already holds where possible. */
  hydrate(element: Any, root: Root): void;
  /** Drop every mounted instance, so the next pass mounts fresh. */
  reset(): void;
}

/**
 * The client and the server differ in their host and their lifecycle, not in
 * the walk. This keeps the walk and the hook slots in one place for both.
 */
export function createRenderer<Root, Instance>(
  host: HostConfig<Root, Instance>,
  options: RendererOptions<Root, Instance> = {},
): Renderer<Root> {
  const context: RenderContext<Root, Instance> = {
    host,
    instances: new Map(),
    rendered: new Set(),
    scope: { key: "root", index: 0 },
    rerender: options.rerender ?? noop,
    onSuspend: options.onSuspend ?? noop,
    boundaries: options.boundaries ?? null,
    onError: options.onError,
    hydrating: false,
    hydration: host.hydration ?? null,
    deferred: null,
    pendingProps: null,
    pass: 0,
  };
  return {
    render(element) {
      const root = host.createRoot();
      renderPass(context, element, root);
      return root;
    },
    hydrate(element, root) {
      const hydration = context.hydration;
      if (hydration === null) throw new Error("This target cannot hydrate.");

      /** Settled retries wait until the pass stops claiming nodes. */
      const suspended: DeferredSuspension[] = [];
      /** Listeners and attributes are applied only if this attempt commits. */
      const queued: PendingProperties<Instance>[] = [];
      let committed = false;

      hydration.begin(root);
      context.hydrating = true;
      context.deferred = suspended;
      context.pendingProps = queued;
      try {
        try {
          renderPass(context, element, root);
          committed = true;
        } catch (error) {
          if (!(error instanceof HydrationMismatchError)) throw error;

          // The markup cannot be lined up with the tree, so the client takes
          // the root over. Hooks and host work from the attempt must not
          // survive, and neither do the retries it armed.
          suspended.length = 0;
          queued.length = 0;
          context.instances.clear();
          context.rendered.clear();
          context.hydrating = false;
          hydration.clear(root);
          renderPass(context, element, root);
        }
      } finally {
        context.hydrating = false;
        context.deferred = null;
        context.pendingProps = null;
        hydration.finish(root);
      }

      // The markup is settled now, so a retry may safely replace the tree.
      if (committed) applyPendingProperties(context, queued);
      for (const { thenable, retry } of suspended) context.onSuspend(thenable, retry);
    },
    reset() {
      context.instances.clear();
      context.rendered.clear();
    },
  };
}

// ---- Prop normalization ----------------------------------------------------

/** Props that never become attributes. */
const RESERVED_PROPS = new Set([
  "children",
  "key",
  "ref",
  "suppressContentEditableWarning",
  "suppressHydrationWarning",
]);

/** Prop name -> attribute name, where the two differ. */
const ATTRIBUTE_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  defaultValue: "value",
  defaultChecked: "checked",
};

/** Attributes whose value need stringify instead of omitting when `false`. */
const ENUMERATED_BOOLEAN_ATTRIBUTES = new Set([
  "contenteditable",
  "draggable",
  "spellcheck",
  "translate",
]);

/** `onClick` -> `click`; only `on` + a capital letter is an event. */
const EVENT_PROP = /^on[A-Z]/;

function normalizeProperties(props: Any): NormalizedProperties {
  const attributes: Array<[string, string]> = [];
  const events: Array<[string, Any]> = [];
  let innerHTML: string | null = null;

  for (const name of Object.keys(props)) {
    const value = props[name];
    if (value === null || value === undefined) continue;
    if (RESERVED_PROPS.has(name)) continue;

    if (name === "dangerouslySetInnerHTML") {
      const html = value.__html;
      if (html !== null && html !== undefined) innerHTML = String(html);
      continue;
    }

    if (EVENT_PROP.test(name)) {
      if (typeof value === "function") events.push([name.slice(2).toLowerCase(), value]);
      continue;
    }

    if (name === "style" && typeof value === "object" && !Array.isArray(value)) {
      const css = styleToCSS(value);
      if (css !== "") attributes.push(["style", css]);
      continue;
    }

    const attribute = ATTRIBUTE_ALIASES[name] ?? name;

    if (typeof value === "boolean") {
      if (ENUMERATED_BOOLEAN_ATTRIBUTES.has(attribute.toLowerCase())) {
        attributes.push([attribute, value ? "true" : "false"]);
      } else if (value) {
        attributes.push([attribute, ""]);
      }
      continue;
    }

    if (typeof value === "string" || typeof value === "number") {
      attributes.push([attribute, String(value)]);
    }
    // Objects, functions and symbols are not valid attribute values: skip them.
  }

  return { attributes, events, innerHTML };
}

/** CSS properties that take unitless numbers. */
const UNITLESS_PROPERTIES = new Set([
  "animationIterationCount",
  "aspectRatio",
  "borderImageOutset",
  "borderImageSlice",
  "borderImageWidth",
  "boxFlex",
  "boxFlexGroup",
  "boxOrdinalGroup",
  "columnCount",
  "columns",
  "flex",
  "flexGrow",
  "flexPositive",
  "flexShrink",
  "flexNegative",
  "flexOrder",
  "gridArea",
  "gridRow",
  "gridRowEnd",
  "gridRowSpan",
  "gridRowStart",
  "gridColumn",
  "gridColumnEnd",
  "gridColumnSpan",
  "gridColumnStart",
  "fontWeight",
  "lineClamp",
  "lineHeight",
  "opacity",
  "order",
  "orphans",
  "tabSize",
  "widows",
  "zIndex",
  "zoom",
  "fillOpacity",
  "floodOpacity",
  "stopOpacity",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
  "scale",
  "scaleX",
  "scaleY",
  "scaleZ",
]);

function styleToCSS(style: Any): string {
  const declarations: string[] = [];
  for (const name of Object.keys(style)) {
    const value = style[name];
    if (value === null || value === undefined || value === "") continue;
    declarations.push(hyphenate(name) + ":" + toCSSValue(name, value));
  }
  return declarations.join(";");
}

function hyphenate(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
}

function toCSSValue(name: string, value: Any): string {
  if (typeof value === "number" && value !== 0 && !isUnitless(name)) return value + "px";
  return String(value);
}

function isUnitless(name: string): boolean {
  if (UNITLESS_PROPERTIES.has(name)) return true;
  const stripped = name.replace(/^(Webkit|Moz|ms|O)/, "");
  if (stripped === name) return false;
  return UNITLESS_PROPERTIES.has(stripped[0].toLowerCase() + stripped.slice(1));
}

// ---- Lazy ------------------------------------------------------------------

function resolveLazy(lazy: LazyWrapper): Any {
  if (typeof lazy._init !== "function") {
    throw new Error("Invalid lazy element type: missing `_init`.");
  }
  // A pending `_init` throws its thenable: the nearest boundary has to see it.
  return lazy._init();
}

/** A short human-readable description, for error messages. */
function describe(value: Any): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return value.toString();
    case "function":
      return "a function" + (value.name ? " (" + value.name + ")" : "");
  }
  const node: Any = value;
  if (node.$$typeof === REACT_ELEMENT_TYPE) return "a React element";
  if (isLazyWrapper(node)) return "a lazy element";
  if (isClientReference(node)) return "a client reference";
  if (isServerReference(node)) return "a server reference";
  return "an object";
}
