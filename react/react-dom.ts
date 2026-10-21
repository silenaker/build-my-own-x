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

interface NormalizedProperties {
  /** `[attributeName, value]`, already stringified. */
  attributes: Array<[string, string]>;
  /** `[eventType, listener]`, e.g. `["click", onClick]`. */
  events: Array<[string, Any]>;
  /** Raw HTML from `dangerouslySetInnerHTML`, or `null` when children are used. */
  innerHTML: string | null;
}

/** Host seam: `Root` is the container, `Instance` is one node in it. */
interface HostConfig<Root, Instance> {
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
}

function renderPass<Root, Instance>(
  context: RenderContext<Root, Instance>,
  element: Any,
  parent: Root | Instance,
): void {
  context.scope = { key: "root", index: 0 };
  context.rendered.clear();
  try {
    renderNode(element, context, parent);
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
  value: Any,
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
): void {
  // A lazy wrapper can also appear as a child, not only as an element's `type`.
  let node: Any = value;
  while (isLazyWrapper(node)) {
    node = resolveLazy(node);
  }

  // Arrays flatten into the parent, so they take no slot of their own.
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child, context, parent);
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
    renderElement(node, index, context, parent);
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
  element: Any,
  index: number,
  context: RenderContext<Root, Instance>,
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
      renderNode(props.children, context, parent);
    });
    return;
  }
  if (type === REACT_SUSPENSE_TYPE) {
    renderSuspense(props, segment, context, parent);
    return;
  }
  if (typeof type === "string") {
    renderHostElement(type, props, segment, context, parent);
    return;
  }

  if (typeof type === "function") {
    renderComponent(type, props, segment, context, parent);
    return;
  }
  throw new Error(
    "Element type is invalid: expected a string (a host tag) or a function (a component) but got: " +
      describe(type) +
      ".",
  );
}

function renderHostElement<Root, Instance>(
  tag: string,
  props: Any,
  segment: string,
  context: RenderContext<Root, Instance>,
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
      renderNode(props.children, context, instance);
    }
  });

  context.host.setInitialProperties(instance, properties);
  context.host.appendChild(parent, instance);
}

function renderComponent<Root, Instance>(
  component: Any,
  props: Any,
  segment: string,
  context: RenderContext<Root, Instance>,
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

  // The output belongs to this instance, so another component at the same slot
  // renames every key below and its children mount fresh.
  renderInScope(context, context.scope.key + "/" + segment + "@" + instance.id, () => {
    renderNode(output, context, parent);
  });
}

/**
 * Children render into a staging root, so a subtree that suspends halfway
 * leaves no trace. The fallback takes its place until the root is retried.
 */
function renderSuspense<Root, Instance>(
  props: Any,
  segment: string,
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
): void {
  const boundaryKey = context.scope.key + "/Suspense" + segment;
  const contentKey = boundaryKey + ":content";
  const staged = context.host.createStagingRoot();

  try {
    renderInScope(context, contentKey, () => {
      renderNode(props.children, context, staged);
      context.host.commitStaged(parent, staged);
    });
  } catch (thrown) {
    if (!isThenable(thrown)) throw thrown;

    // The attempt never committed, but the retry enters at the same keys and
    // should find the hooks it already mounted.
    retainScope(context, contentKey);
    context.onSuspend(thrown);

    const fallbackStage = context.host.createStagingRoot();
    renderInScope(context, boundaryKey + ":fallback", () => {
      renderNode(props.fallback, context, fallbackStage);
      context.host.commitStaged(parent, fallbackStage);
    });
  }
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

// ---- The HTML host (renderToString) ----------------------------------------

interface HtmlRoot {
  kind: "root";
  children: HtmlNode[];
}
interface HtmlElement {
  kind: "element";
  tag: string;
  attributes: Array<[string, string]>;
  children: HtmlNode[];
  innerHTML: string | null;
}
interface HtmlText {
  kind: "text";
  text: string;
}
type HtmlNode = HtmlElement | HtmlText;

const htmlHost: HostConfig<HtmlRoot, HtmlNode> = {
  createRoot: () => ({ kind: "root", children: [] }),
  createInstance: (tag) => ({
    kind: "element",
    tag,
    attributes: [],
    children: [],
    innerHTML: null,
  }),
  createTextInstance: (text) => ({ kind: "text", text }),
  appendChild: (parent, child) => {
    if (parent.kind === "root" || parent.kind === "element") {
      parent.children.push(child);
    } else {
      throw new Error("Cannot append a child to a text node.");
    }
  },
  setInitialProperties: (instance, properties) => {
    if (instance.kind === "element") instance.attributes = properties.attributes;
  },
  setInnerHTML: (instance, html) => {
    if (instance.kind === "element") instance.innerHTML = html;
  },
  createStagingRoot: () => ({ kind: "root", children: [] }),
  commitStaged: (parent, staged) => {
    if ((parent.kind === "root" || parent.kind === "element") && staged.kind === "root") {
      for (const child of staged.children) parent.children.push(child);
      staged.children.length = 0;
    }
  },
};

/** Elements that must not have a closing tag. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ESCAPE_LOOKUP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
const ESCAPE_REGEX = /[&<>"']/g;

/** Escape text and attribute values. */
function escapeText(text: string): string {
  return text.replace(ESCAPE_REGEX, (character) => ESCAPE_LOOKUP[character]);
}

function serializeNode(node: HtmlRoot | HtmlNode): string {
  if (node.kind === "root") return node.children.map(serializeNode).join("");
  if (node.kind === "text") return escapeText(node.text);

  const attributes = node.attributes
    .map(([name, value]) => " " + name + '="' + escapeText(value) + '"')
    .join("");
  if (VOID_ELEMENTS.has(node.tag.toLowerCase())) return "<" + node.tag + attributes + "/>";

  const content =
    node.innerHTML !== null ? node.innerHTML : node.children.map(serializeNode).join("");
  return "<" + node.tag + attributes + ">" + content + "</" + node.tag + ">";
}

export function renderToString(element: Any): string {
  const context: RenderContext<HtmlRoot, HtmlNode> = {
    host: htmlHost,
    instances: new Map(),
    rendered: new Set(),
    scope: { key: "root", index: 0 },
    rerender: noop,
    onSuspend: noop,
  };
  const root = context.host.createRoot();
  renderPass(context, element, root);
  return serializeNode(root);
}

// ---- The DOM host (createRoot) ---------------------------------------------

export interface ReactDomRoot {
  /** Mount `element`. A later `render` replaces the whole tree. */
  render(element: Any): void;
  /** Remove everything this root rendered. */
  unmount(): void;
}

function createDomHost(document: Document, container: Element): HostConfig<Element, Node> {
  return {
    createRoot: () => container,
    createInstance: (tag) => document.createElement(tag),
    createTextInstance: (text) => document.createTextNode(text),
    appendChild: (parent, child) => {
      parent.appendChild(child);
    },
    setInitialProperties: (instance, properties) => {
      // Only elements reach here; text nodes have no properties.
      const element = instance as Element;
      for (const [name, value] of properties.attributes) element.setAttribute(name, value);
      for (const [type, listener] of properties.events) element.addEventListener(type, listener);
    },
    setInnerHTML: (instance, html) => {
      (instance as Element).innerHTML = html;
    },
    createStagingRoot: () => document.createDocumentFragment(),
    commitStaged: (parent, staged) => {
      (parent as Node).appendChild(staged as Node);
    },
  };
}

function clearChildren(container: Element): void {
  let child = container.firstChild;
  while (child !== null) {
    container.removeChild(child);
    child = container.firstChild;
  }
}

export function createRoot(container: Element): ReactDomRoot {
  const document = container.ownerDocument;
  if (document === null) {
    throw new Error("createRoot() requires a container that belongs to a document.");
  }

  /** Thenables a boundary is waiting on, so a settlement retries the root once. */
  const waiting = new Set<Thenable>();

  let rootElement: Any = null;
  let mounted = false;
  let rendering = false;
  let needsRerender = false;

  const context: RenderContext<Element, Node> = {
    host: createDomHost(document, container),
    instances: new Map(),
    rendered: new Set(),
    scope: { key: "root", index: 0 },
    rerender: () => rerender(),
    onSuspend: retryWhenSettled,
  };

  function retryWhenSettled(thenable: Thenable): void {
    if (waiting.has(thenable)) return;
    waiting.add(thenable);
    const retry = (): void => {
      waiting.delete(thenable);
      rerender();
    };
    // A rejection retries too: `use()` throws the reason on the next pass.
    thenable.then(retry, retry);
  }

  function rerender(): void {
    if (!mounted) return;
    if (rendering) {
      needsRerender = true;
      return;
    }
    rendering = true;
    try {
      do {
        needsRerender = false;
        clearChildren(container);
        renderPass(context, rootElement, container);
      } while (needsRerender);
    } finally {
      rendering = false;
    }
  }

  return {
    render(element: Any): void {
      rootElement = element;
      mounted = true;
      rerender();
    },
    unmount(): void {
      clearChildren(container);
      context.instances.clear();
      context.rendered.clear();
      waiting.clear();
      mounted = false;
      rootElement = null;
    },
  };
}
