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
  /** Move everything staged into `parent`. */
  commitStaged(parent: Root | Instance, staged: Root | Instance): void;
  /** Fizz markers live in comments, so every target has to be able to make one. */
  createCommentInstance(text: string): Instance;
  /** Rewrite a marker once the boundary's outcome is known. */
  setCommentText(instance: Instance, text: string): void;
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
   * A boundary is waiting on this thenable. The DOM root retries once it
   * settles; the HTML target cannot wait, so it keeps the fallback.
   */
  onSuspend: (thenable: Thenable) => void;
  /** Set only by server targets that can complete a boundary later. */
  boundaries: BoundaryTracker<Root, Instance> | null;
  /** Report an error a boundary swallowed, without failing the whole tree. */
  onError?: (error: Any) => void;
}

function renderPass<Root, Instance>(
  context: RenderContext<Root, Instance>,
  element: Any,
  parent: Root | Instance,
): void {
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
      context.host.appendChild(parent, context.host.createTextInstance(node));
      return;
    case "number":
      context.host.appendChild(parent, context.host.createTextInstance("" + node));
      return;
    case "bigint":
      context.host.appendChild(parent, context.host.createTextInstance(String(node)));
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
  const instance = context.host.createInstance(tag);
  const properties = normalizeProperties(props);

  // The tag is part of the path, so replacing this element remounts its children.
  renderInScope(context, context.scope.key + "/" + tag + segment, () => {
    if (properties.innerHTML !== null) {
      // `dangerouslySetInnerHTML` wins over children.
      context.host.setInnerHTML(instance, properties.innerHTML);
    } else {
      renderNode(context, props.children, instance);
    }
  });

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
  const tracker = context.boundaries;
  const id = tracker === null ? 0 : tracker.idFor(boundaryKey);

  // The start marker is written before the outcome is known, so a suspension
  // can turn it into `$?` without moving what precedes it.
  const start = tracker === null ? null : context.host.createCommentInstance("$");
  if (start !== null) context.host.appendChild(parent, start);

  let staged: Root | Instance;
  try {
    staged = renderBoundaryChildren(context, props, contentKey, id);
  } catch (thrown) {
    if (tracker === null) {
      if (!isThenable(thrown)) throw thrown;

      // The attempt never committed, but the retry enters at the same keys and
      // should find the hooks it already mounted.
      retainScope(context, contentKey);
      context.onSuspend(thrown);
      renderBoundaryFallback(context, props, boundaryKey, parent);
      return;
    }

    retainScope(context, contentKey);

    if (isThenable(thrown)) {
      context.host.setCommentText(start as Instance, "$?");
      context.host.appendChild(parent, createBoundaryTemplate(context, id, null));
      renderBoundaryFallback(context, props, boundaryKey, parent);
      context.host.appendChild(parent, context.host.createCommentInstance("/$"));
      tracker.postpone(id, thrown, () => renderBoundaryChildren(context, props, contentKey, id));
    } else {
      // The boundary cannot recover on the client either, so its fallback is
      // the final output and the error only goes to `onError`.
      context.host.setCommentText(start as Instance, "$!");
      context.host.appendChild(parent, createBoundaryTemplate(context, id, thrown));
      renderBoundaryFallback(context, props, boundaryKey, parent);
      context.host.appendChild(parent, context.host.createCommentInstance("/$"));
      context.onError?.(thrown);
      tracker.finish(id);
    }
    return;
  }

  context.host.commitStaged(parent, staged);
  if (tracker !== null) {
    context.host.appendChild(parent, context.host.createCommentInstance("/$"));
    tracker.finish(id);
  }
}

/** Render the boundary's children into a detached root, naming `id` as their parent. */
function renderBoundaryChildren<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  contentKey: string,
  id: number,
): Root | Instance {
  const tracker = context.boundaries;
  const previous = tracker === null ? null : tracker.parent;
  if (tracker !== null) tracker.parent = id;
  const staged = context.host.createStagingRoot();
  try {
    renderInScope(context, contentKey, () => {
      renderNode(context, props.children, staged);
    });
  } finally {
    if (tracker !== null) tracker.parent = previous;
  }
  return staged;
}

/** Fallbacks are already in the document, so a boundary inside one can stream at once. */
function renderBoundaryFallback<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  boundaryKey: string,
  parent: Root | Instance,
): void {
  const tracker = context.boundaries;
  const previous = tracker === null ? null : tracker.parent;
  if (tracker !== null) tracker.parent = null;
  try {
    const fallbackStage = context.host.createStagingRoot();
    renderInScope(context, boundaryKey + ":fallback", () => {
      renderNode(context, props.fallback, fallbackStage);
      context.host.commitStaged(parent, fallbackStage);
    });
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

// ---- The public renderer ---------------------------------------------------

export interface RendererOptions<Root, Instance> {
  /** Set only by server targets that can complete a boundary later. */
  boundaries?: BoundaryTracker<Root, Instance> | null;
  /** Report an error a boundary swallowed, without failing the whole tree. */
  onError?: (error: Any) => void;
  /** Re-render the root after a state update; the DOM target supplies one. */
  rerender?: () => void;
  /** A boundary suspended; the DOM target retries once it settles. */
  onSuspend?: (thenable: Thenable) => void;
}

/** One host-bound walker. Every pass reuses the hook instances it mounted. */
export interface Renderer<Root> {
  /** Fill a fresh root with `element`. */
  render(element: Any): Root;
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
  };
  return {
    render(element) {
      const root = host.createRoot();
      renderPass(context, element, root);
      return root;
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
