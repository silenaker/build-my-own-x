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
  /** Set only on targets that keep the tree they already rendered. */
  patch?: PatchConfig<Root, Instance> | null;
}

/**
 * A target that patches its tree reuses the host instance a path held in the
 * previous pass, so a re-render touches only what the new element changed.
 */
export interface PatchConfig<Root, Instance> {
  /** Start a pass; every key the walker reaches has to be retained again. */
  begin(): void;
  /** The instance this path held before the pass, or `null` when it held none. */
  claim(key: string): Instance | null;
  /** Record `instance` as the occupant of `key` for the next pass. */
  retain(key: string, instance: Instance): void;
  /** Bring a claimed host element up to date with its new props. */
  updateProperties(instance: Instance, properties: NormalizedProperties): void;
  /** A claimed text node has different content. */
  updateText(instance: Instance, text: string): void;
  /** The pass emitted its last child of `parent`; drop whatever is left over. */
  finishChildren(parent: Root | Instance): void;
  /** End the pass; only keys under `prefix` are forgotten, or all of them without one. */
  end(prefix?: string): void;
  /** Forget every key, so the root renders from scratch again. */
  reset(): void;
  /** The index in `parent` where the pass's next child will go. */
  position(parent: Root | Instance): number;
  /** Resume placing children of `parent` at `index`, so a scoped pass keeps its slot. */
  positionAt(parent: Root | Instance, index: number): void;
  /** The index of `instance` among the children of `parent`, or -1 when it moved away. */
  positionOf(parent: Root | Instance, instance: Instance): number;
  /** The children of `parent` the pass placed between `start` and the current cursor. */
  nodesBetween(parent: Root | Instance, start: number): Instance[];
  /** Drop one node a scoped pass no longer emits. */
  remove(parent: Root | Instance, instance: Instance): void;
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
  /** `useEffect` / `useLayoutEffect`: what the last commit ran and what it owes. */
  effect?: EffectHook;
}

/**
 * One effect hook's committed state. The latest render's callback and deps live
 * in the pass that read them, so a render that never commits leaves this alone.
 */
interface EffectHook {
  /** Cleanup returned by the last run, owed before the next one or on unmount. */
  destroy: (() => void) | undefined;
  /** Deps of the last run, so an unchanged list leaves the effect alone. */
  committedDeps: unknown[] | undefined;
  /** False until the first run; without it an effect with no deps looks settled. */
  ran: boolean;
  /** `useLayoutEffect` commits with the tree; `useEffect` waits for the paint. */
  layout: boolean;
}

/** One effect a commit owes, captured as the render that read it wrote it. */
interface PendingEffect {
  /** The component the hook belongs to, so a later unmount can cancel the run. */
  instance: ComponentInstance;
  hook: EffectHook;
  create: () => void | (() => void);
  deps: unknown[] | undefined;
}

/**
 * Something whose committed output the update path has to locate among a
 * parent's children: a component's output, or the range a boundary owns.
 */
interface RangeOwner {
  /** Host parent the output was committed to, or `null` while it has no stable location. */
  parent: Any;
  /** Nodes the committed output occupies, or `null` when only a root pass can locate it. */
  output: Any[] | null;
}

interface ComponentInstance {
  hooks: HookSlot[];
  /** Ordinal of the next hook call. */
  hookIndex: number;
  /** Effects read by the invocation in progress, in the order they were declared. */
  pending: PendingEffect[];
  /** Apply this component's queued state, without re-rendering the root. */
  rerender: () => void;
  /** The component the hooks belong to; another one at the same slot mounts fresh. */
  type: Any;
  /** Distinguishes one mounted instance from the next one at the same slot. */
  id: number;
  /** Path of this component in the instance map, so a pass can prune only its subtree. */
  key: string;
  /** Props of the last committed render; a state update re-runs the component with them. */
  props: Any;
  /** Scope depth, so coalesced updates run ancestors before descendants. */
  depth: number;
  /** Scope the output was rendered in; keys inside it stay stable across updates. */
  outputKey: string;
  /** Host parent the output was committed to, or `null` while it has no stable location. */
  parent: Any;
  /** Nodes the committed output occupies, or `null` when only a root pass can locate it. */
  output: Any[] | null;
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

/**
 * Record an effect for the commit that may follow. Nothing runs here: whether
 * the callback is owed depends on the deps and on the render reaching the screen.
 */
function readEffect(
  create: () => void | (() => void),
  deps: unknown[] | undefined,
  layout: boolean,
): void {
  const instance = requireInstance();
  const hook = nextHook();
  if (hook.effect === undefined) {
    hook.effect = { destroy: undefined, committedDeps: undefined, ran: false, layout };
  }
  hook.effect.layout = layout;
  // The pass keeps the callback and deps it read, so a later render cannot
  // rewrite an effect that is still waiting to run.
  instance.pending.push({ instance, hook: hook.effect, create, deps });
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
  useEffect: (create, deps) => readEffect(create, deps, false),
  useLayoutEffect: (create, deps) => readEffect(create, deps, true),
};

const noop = (): void => {};

// ---- The element walker ----------------------------------------------------

/**
 * One container the walker fills: the root, a host element, a component, or a
 * boundary's content or fallback. The key is the path to that container, so a
 * replaced ancestor renames the whole subtree and its instances go with it.
 */

/** A boundary the client can re-render on its own once its content is ready. */
interface ClientBoundary {
  /** Path of the boundary, so a later render updates the same record. */
  key: string;
  /** Scopes of the content and fallback; their keys locate the nodes they own. */
  contentKey: string;
  fallbackKey: string;
  /** Host parent the boundary was committed into. */
  parent: Any;
  /** Latest props, so a retry never renders children from an older tree. */
  props: Any;
  /** Nodes the boundary owns now: content when resolved, fallback while waiting. */
  output: Any[] | null;
  /** True while `output` is a fallback for a thenable that has not settled. */
  pending: boolean;
  /** Pass that last rendered it, so a boundary missing from a pass can be dropped. */
  pass: number;
  /** Re-render this range in place; replaced only when the record itself is replaced. */
  retry: () => void;
}

interface RenderScope {
  /** Path from the root to this container; prefixes every key below it. */
  key: string;
  /** Ordinal of the next child here; every child consumes one. */
  index: number;
  /** Distance from the root; a component update uses it to run ancestors first. */
  depth: number;
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
  /** Set only when the target keeps its tree, so instances are updated in place. */
  patch: PatchConfig<Root, Instance> | null;
  hydration: HydrationConfig<Root, Instance> | null;
  /** Thenables found mid-hydration; they are reported only after the pass ends. */
  deferred: DeferredSuspension[] | null;
  /** Host properties claimed by a hydrating pass, applied only if it commits. */
  pendingProps: PendingProperties<Instance>[] | null;
  /** Full passes so far, so a boundary missing from one can be told apart. */
  pass: number;
  /** Boundary scopes this pass armed a retry for, mirroring `rendered` above. */
  armed: Set<string>;
  /** The wait each boundary is holding; a re-render of it replaces only its retry. */
  waits: Map<string, BoundaryWait>;
  /** Apply one component's queued state, either in place or as part of a root pass. */
  schedule: (instance: ComponentInstance) => void;
  /**
   * Output ranges recorded inside a staging root, keyed by that root. A staged
   * node has no parent in the document yet, so each range is settled by the
   * commit that moves the root into the tree (or dropped with the root).
   */
  stagedRanges: Map<Any, StagedRange[]>;
  /** Client boundaries by path, so a retry can find the range it owns. */
  clientBoundaries: Map<string, ClientBoundary>;
  /** True while a scheduled retry is walking, so dispatches queue instead of re-entering. */
  rendering: boolean;
  /** Let the scheduler settle queued state after a scoped retry, like it does after a pass. */
  afterPass: () => void;
  /** Effects the committed work recorded, or `null` on a target that never runs them. */
  effects: PendingEffect[] | null;
  /** Cleanups owned by components that left the tree during a pass. */
  cleanups: EffectHook[];
  /** Run what the commit recorded: layout effects now, passive effects after the paint. */
  flushEffects: () => void;
}

interface DeferredSuspension {
  thenable: Thenable;
  retry: () => void;
  /** The content scope that armed the retry, so a later replacement can drop it. */
  key: string;
}

/** One boundary's wait on a thenable, kept while the boundary stays on screen. */
interface BoundaryWait {
  /** Scope of the boundary, so a wait a pass dropped can tell that it is gone. */
  key: string;
  /** The thenable this wait was armed for; waiting on another one starts a new wait. */
  thenable: Thenable;
  /** The retry the boundary wants now; a re-render replaces this field, not the wait. */
  retry: () => void;
  /** Handed to the host for `thenable`, so arming the same wait twice registers once. */
  settle: () => void;
}

interface PendingProperties<Instance> {
  instance: Instance;
  properties: NormalizedProperties;
  /** The element's path, so a suspended attempt drops only its own work. */
  key: string;
}

/**
 * An output range recorded inside a staging root. The nodes keep their
 * identity when the root commits, so only the parent is unknown until then.
 */
interface StagedRange {
  owner: RangeOwner;
  /** Nodes the owner emitted, in the order it emitted them. */
  nodes: Any[];
}

/** The element tree and the server markup cannot be lined up node for node. */
class HydrationMismatchError extends Error {}

function renderPass<Root, Instance>(
  context: RenderContext<Root, Instance>,
  element: Any,
  parent: Root | Instance,
): void {
  context.pass++;
  context.scope = { key: "root", index: 0, depth: 0 };
  context.rendered.clear();
  context.armed.clear();
  if (context.boundaries !== null) context.boundaries.parent = null;
  context.patch?.begin();
  try {
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
    // Hydration prunes what it did not claim itself, once the pass settles.
    if (!context.hydrating) context.patch?.finishChildren(parent);
  } finally {
    context.patch?.end();
  }
  // A root pass owns every key, so anything it never reached is gone.
  prunePass(context);
}

/**
 * Drop what a pass did not reach. Instances, boundary records and waits are all
 * keyed by path, so a pass owns the keys under `prefix` (or every key when it
 * rendered the whole tree) and forgets the rest; that is how each of them learns
 * it is gone.
 */
function prunePass<Root, Instance>(context: RenderContext<Root, Instance>, prefix?: string): void {
  const owns = (key: string): boolean => prefix === undefined || key.startsWith(prefix);

  // A component the pass missed was unmounted, so its hooks must not leak into
  // whichever component later occupies the same path.
  for (const key of [...context.instances.keys()]) {
    if (!owns(key) || context.rendered.has(key)) continue;
    const instance = context.instances.get(key) as ComponentInstance;
    context.instances.delete(key);
    // What the component ran it now owes a cleanup, in the phase that ran it.
    for (const hook of instance.hooks) {
      const effect = hook.effect;
      if (effect !== undefined && effect.ran) context.cleanups.push(effect);
    }
  }
  // A boundary the pass missed is gone, so its retry must not fire later.
  for (const [key, record] of [...context.clientBoundaries]) {
    if (owns(key) && record.pass !== context.pass) context.clientBoundaries.delete(key);
  }
  // A boundary that armed nothing has stopped waiting.
  for (const key of [...context.waits.keys()]) {
    if (owns(key) && !context.armed.has(key)) context.waits.delete(key);
  }
}

/** Run `render` with a fresh child scope named `key`. */
function renderInScope<Root, Instance>(
  context: RenderContext<Root, Instance>,
  key: string,
  render: () => void,
): void {
  const outer = context.scope;
  context.scope = { key, index: 0, depth: outer.depth + 1 };
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
      pending: [],
      key,
      props: null,
      depth: 0,
      outputKey: "",
      parent: null,
      output: null,
      rerender: noop,
    };
    context.instances.set(key, instance);
    // The instance closes over itself, so a dispatch marks exactly this slot.
    instance.rerender = () => context.schedule(instance as ComponentInstance);
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
      renderText(context, parent, node, index);
      return;
    case "number":
      renderText(context, parent, "" + node, index);
      return;
    case "bigint":
      renderText(context, parent, String(node), index);
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
  index: number,
): void {
  // The prefix keeps a text path apart from a host tag that happens to be named `#text`.
  const key = context.scope.key + "/#text" + index;
  if (context.hydrating) {
    const node = claimNode(context, parent, "text");
    if (node.value !== text) {
      // A different string means every following node is out of alignment too.
      throw new HydrationMismatchError();
    }
    context.patch?.retain(key, node.instance);
    return;
  }

  const patch = context.patch;
  if (patch === null) {
    context.host.appendChild(parent, context.host.createTextInstance(text));
    return;
  }

  const claimed = patch.claim(key);
  if (claimed !== null) {
    patch.retain(key, claimed);
    patch.updateText(claimed, text);
    context.host.appendChild(parent, claimed);
    return;
  }
  const created = context.host.createTextInstance(text);
  patch.retain(key, created);
  context.host.appendChild(parent, created);
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
  // The tag is part of the path, so replacing this element remounts its children.
  const elementKey = context.scope.key + "/" + tag + segment;

  let instance: Instance;
  let claimed = false;
  if (context.hydrating) {
    const node = claimNode(context, parent, "element");
    if (node.value !== tag) throw new HydrationMismatchError();
    instance = node.instance;
    context.patch?.retain(elementKey, instance);
  } else {
    const previous = context.patch?.claim(elementKey) ?? null;
    if (previous !== null) {
      claimed = true;
      instance = previous;
    } else {
      instance = context.host.createInstance(tag);
    }
    context.patch?.retain(elementKey, instance);
  }

  const usesHTML = properties.innerHTML !== null;
  renderInScope(context, elementKey, () => {
    if (usesHTML) {
      // `dangerouslySetInnerHTML` wins over children.
      // Hydration trusts the server's HTML, so it stays untouched.
      if (!context.hydrating && !claimed) {
        context.host.setInnerHTML(instance, properties.innerHTML as string);
      }
    } else {
      renderNode(context, props.children, instance);
    }
  });

  if (context.hydrating) {
    // Applied only if the attempt commits, so a retry cannot bind listeners twice.
    context.pendingProps?.push({ instance, properties, key: elementKey });
    return;
  }
  if (claimed) {
    context.patch?.updateProperties(instance, properties);
    // `innerHTML` owns the children, so a pass that rendered none must not prune them.
    if (!usesHTML) context.patch?.finishChildren(instance);
  } else {
    context.host.setInitialProperties(instance, properties);
  }
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
  const output = invokeComponent(instance, component, props);

  const outputKey = context.scope.key + "/" + segment + "@" + instance.id;
  instance.props = props;
  instance.depth = context.scope.depth;
  instance.outputKey = outputKey;

  const patch = context.patch;
  // Every pass that creates nodes can name the range an update will replace; a
  // staged parent settles its range once the root commits into the document.
  if (patch !== null && !context.hydrating) {
    const start = patch.position(parent);
    renderInScope(context, outputKey, () => {
      renderNode(context, output, parent);
    });
    recordOutput(context, instance, parent, patch.nodesBetween(parent, start));
    commitInstanceEffects(context, instance);
    return;
  }

  // A hydrating subtree reuses the nodes the server left, so only a root pass
  // can locate this output again.
  instance.output = null;
  renderInScope(context, outputKey, () => {
    renderNode(context, output, parent);
  });
  commitInstanceEffects(context, instance);
}

/**
 * Hand a component's effects to the pass once its subtree has rendered, so the
 * order is children first and a subtree that threw never commits at all.
 */
function commitInstanceEffects<Root, Instance>(
  context: RenderContext<Root, Instance>,
  instance: ComponentInstance,
): void {
  const effects = context.effects;
  if (effects === null) return;
  for (const pending of instance.pending) effects.push(pending);
}

/**
 * Name the nodes an owner's output occupies. Nodes appended to a staging root
 * have no parent in the document yet, so the range waits for the commit that
 * moves them into the tree; anywhere else the range is final right away.
 */
function recordOutput<Root, Instance>(
  context: RenderContext<Root, Instance>,
  owner: RangeOwner,
  parent: Root | Instance,
  nodes: Any[],
): void {
  const staged = context.stagedRanges.get(parent);
  if (staged !== undefined) {
    // Until the root commits there is no slot to name, so pretending otherwise
    // would let an update patch a range that is not in the tree.
    owner.parent = null;
    owner.output = null;
    staged.push({ owner, nodes });
    return;
  }
  owner.parent = parent;
  owner.output = nodes;
}

/** Run the component with its hooks bound to `instance`. */
function invokeComponent(instance: ComponentInstance, component: Any, props: Any): Any {
  const previousDispatcher = ReactSharedInternals.currentDispatcher;
  const previousInstance = currentInstance;

  currentInstance = instance;
  instance.hookIndex = 0;
  // A previous invocation's effects never reached a commit; this one owns the list.
  instance.pending.length = 0;
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
  return output;
}

/** What a targeted update achieved, so the scheduler knows whether it still owes work. */
type UpdateResult = "rendered" | "stale" | "fallback" | "suspended";

/**
 * Re-run one component where its output already sits. Only that output range is
 * re-placed and pruned, so ancestors, siblings and their DOM stay untouched.
 */
function renderComponentUpdate<Root, Instance>(
  context: RenderContext<Root, Instance>,
  instance: ComponentInstance,
): UpdateResult {
  if (context.instances.get(instance.key) !== instance) {
    // The component was unmounted; its queued state belongs to nothing now.
    return "stale";
  }

  const patch = context.patch;
  const parent = instance.parent as Root | Instance | null;
  const previous = instance.output;
  if (patch === null || parent === null || previous === null || previous.length === 0) {
    // No settled range was recorded, so only a root pass can find the output again.
    return "fallback";
  }

  const start = patch.positionOf(parent, previous[0] as Instance);
  if (start === -1) {
    // The anchor moved out from under us; the root pass re-establishes the tree.
    return "fallback";
  }

  context.pass++;
  context.rendered.clear();
  context.rendered.add(instance.key);
  context.armed.clear();
  context.scope = { key: instance.outputKey, index: 0, depth: instance.depth + 1 };
  const effectMark = context.effects === null ? 0 : context.effects.length;
  patch.begin();
  patch.positionAt(parent, start);
  try {
    try {
      const output = invokeComponent(instance, instance.type, instance.props);
      renderNode(context, output, parent);
    } catch (thrown) {
      // The attempt is thrown away, so the effects its subtree read are not owed.
      if (context.effects !== null) context.effects.length = effectMark;
      // The boundary that could catch this is above the scope this pass started
      // in, so only a root pass can put it back on the stack.
      if (isThenable(thrown)) return "suspended";
      throw thrown;
    }

    const next = patch.nodesBetween(parent, start);
    // A node the component no longer emits would otherwise leave duplicated output.
    for (const node of previous) {
      if (!next.includes(node)) patch.remove(parent, node as Instance);
    }
    instance.output = next;
    commitInstanceEffects(context, instance);
  } finally {
    patch.end(instance.outputKey + "/");
  }

  // Components the pass did not reach went away with the replaced output; so did
  // the boundaries it never re-rendered. The pass only owns its own subtree.
  prunePass(context, instance.outputKey + "/");
  // The update reached the document, so the effects it recorded are owed now.
  context.flushEffects();
  return "rendered";
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
    renderSuspenseContent(context, props, boundaryKey, contentKey, fallbackKey, parent);
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

  commitStagedRoot(context, parent, staged);
  context.host.appendChild(parent, context.host.createCommentInstance("/$"));
  tracker.finish(id);
}

/** The client path: no markers, and a suspension leaves the fallback in place. */
function renderSuspenseContent<Root, Instance>(
  context: RenderContext<Root, Instance>,
  props: Any,
  boundaryKey: string,
  contentKey: string,
  fallbackKey: string,
  parent: Root | Instance,
): void {
  const patch = context.patch;
  // A staged parent has no cursor in the document, but its own children are
  // still numbered, so the range is just settled later, when it commits.
  const start = patch !== null && !context.hydrating ? patch.position(parent) : -1;
  const record =
    patch === null
      ? null
      : registerClientBoundary(context, boundaryKey, contentKey, fallbackKey, props, parent);

  let staged: Root | Instance;
  try {
    staged = renderBoundaryChildren(context, props.children, contentKey, 0);
  } catch (thrown) {
    if (!isThenable(thrown)) throw thrown;
    retainScope(context, contentKey);
    // The attempt is thrown away, so boundaries it armed go with it.
    dropStagedWaits(context, contentKey);
    renderBoundaryFallback(context, props.fallback, fallbackKey, parent);
    if (start >= 0 && record !== null && patch !== null) {
      recordOutput(context, record, parent, patch.nodesBetween(parent, start));
      record.pending = true;
      suspendContent(context, contentKey, thrown, record.retry);
    } else {
      // Without a range to replace, only a root pass can find the boundary again.
      if (record !== null) {
        record.output = null;
        record.pending = false;
      }
      suspendContent(context, contentKey, thrown, context.rerender);
    }
    return;
  }
  commitStagedRoot(context, parent, staged);
  if (record !== null) {
    if (start >= 0 && patch !== null) {
      recordOutput(context, record, parent, patch.nodesBetween(parent, start));
    } else {
      record.output = null;
    }
    record.pending = false;
  }
}

/** The boundary's record for this tree, so a retry re-renders its latest props. */
function registerClientBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  key: string,
  contentKey: string,
  fallbackKey: string,
  props: Any,
  parent: Root | Instance,
): ClientBoundary {
  let record = context.clientBoundaries.get(key);
  if (record === undefined) {
    record = {
      key,
      contentKey,
      fallbackKey,
      parent,
      props,
      output: null,
      pending: false,
      pass: context.pass,
      retry: () => retryClientBoundary(context, record as ClientBoundary),
    };
    context.clientBoundaries.set(key, record);
  }
  record.parent = parent;
  record.props = props;
  record.pass = context.pass;
  return record;
}

/**
 * Replace one boundary's fallback with its content. Only the recorded range is
 * touched, so a late settlement never walks or patches the rest of the tree.
 */
function retryClientBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  record: ClientBoundary,
): void {
  const patch = context.patch;
  if (patch === null) return;
  if (context.clientBoundaries.get(record.key) !== record) {
    // A newer tree owns this path; only a root pass can find the boundary again.
    context.rerender();
    return;
  }
  if (!record.pending) return;

  const parent = record.parent as Root | Instance;
  const previous = record.output;
  if (previous === null || previous.length === 0 || context.hydrating) {
    // Without a settled range there is nothing scoped to replace.
    context.rerender();
    return;
  }
  const start = patch.positionOf(parent, previous[0] as Instance);
  if (start === -1) {
    context.rerender();
    return;
  }

  context.pass++;
  context.rendered.clear();
  context.armed.clear();
  context.rendering = true;
  patch.begin();
  patch.positionAt(parent, start);
  try {
    let staged: Root | Instance;
    try {
      staged = renderBoundaryChildren(context, record.props.children, record.contentKey, 0);
    } catch (thrown) {
      if (!isThenable(thrown)) throw thrown;
      // The fallback is still on screen, so only the wait has to be renewed.
      retainScope(context, record.contentKey);
      record.pass = context.pass;
      dropStagedWaits(context, record.contentKey);
      suspendContent(context, record.contentKey, thrown, record.retry);
      return;
    }

    for (const node of previous) patch.remove(parent, node as Instance);
    commitStagedRoot(context, parent, staged);
    record.output = patch.nodesBetween(parent, start);
    record.pending = false;
    record.pass = context.pass;
  } finally {
    context.rendering = false;
    patch.end(record.key + ":");
    // The retry replaced one boundary's range, so it only owns that range.
    prunePass(context, record.key + ":");
    // A retry is its own commit: nothing above it will flush what it ran.
    context.flushEffects();
    context.afterPass();
  }
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
    return renderIntoStagingRoot(context, contentKey, children);
  } finally {
    if (tracker !== null) tracker.parent = previous;
  }
}

/**
 * Render `children` into a detached root. Output recorded there cannot name a
 * parent yet, so an attempt that throws drops its ranges with the root.
 */
function renderIntoStagingRoot<Root, Instance>(
  context: RenderContext<Root, Instance>,
  key: string,
  children: Any,
): Root | Instance {
  const staged = context.host.createStagingRoot();
  context.stagedRanges.set(staged, []);
  const effects = context.effects;
  const mark = effects === null ? 0 : effects.length;
  try {
    renderInScope(context, key, () => {
      renderNode(context, children, staged);
    });
  } catch (thrown) {
    // The attempt never reaches the document, so nothing it recorded can settle.
    context.stagedRanges.delete(staged);
    // Its effects are owed by a tree that was never committed, so they go too.
    if (effects !== null) effects.length = mark;
    throw thrown;
  }
  return staged;
}

/**
 * Move a staged root into `parent` and settle the ranges recorded inside it.
 * The nodes keep their identity through the move, so a range only has to be
 * repointed; a root committed into another staging root stays pending.
 */
function commitStagedRoot<Root, Instance>(
  context: RenderContext<Root, Instance>,
  parent: Root | Instance,
  staged: Root | Instance,
  reference?: Instance | null,
): void {
  const ranges = context.stagedRanges.get(staged);
  context.stagedRanges.delete(staged);
  context.host.commitStaged(parent, staged, reference);
  if (ranges === undefined) return;

  const outer = context.stagedRanges.get(parent);
  if (outer !== undefined) {
    // The ranges move with their nodes, so they settle when the outer root does.
    for (const range of ranges) outer.push(range);
    return;
  }
  for (const { owner, nodes } of ranges) {
    owner.parent = parent;
    owner.output = nodes;
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
    const staged = renderIntoStagingRoot(context, fallbackKey, fallback);
    commitStagedRoot(context, parent, staged);
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
  suspendContent(context, contentKey, thenable, retry);
}

/**
 * Wait on `thenable` for the boundary at `contentKey` and name the retry that
 * settles it. The boundary keeps one wait while it stays on screen and keeps
 * waiting on the same thenable: a re-render only replaces the retry it holds, so
 * the host's registration stays a single one and always runs the newest props.
 * Waiting on another thenable starts a new wait, which leaves the wake-up the
 * previous one registered with nothing to settle.
 */
function suspendContent<Root, Instance>(
  context: RenderContext<Root, Instance>,
  contentKey: string,
  thenable: Thenable,
  retry: () => void,
): void {
  context.armed.add(contentKey);
  let wait = context.waits.get(contentKey);
  if (wait === undefined || wait.thenable !== thenable) {
    const created: BoundaryWait = {
      key: contentKey,
      thenable,
      retry,
      settle: () => settleBoundary(context, created),
    };
    wait = created;
    context.waits.set(contentKey, created);
  }
  wait.retry = retry;
  suspend(context, thenable, wait.settle, contentKey);
}

/** Run the boundary's newest retry; a wait the pass dropped or replaced runs nothing. */
function settleBoundary<Root, Instance>(
  context: RenderContext<Root, Instance>,
  wait: BoundaryWait,
): void {
  if (context.waits.get(wait.key) !== wait) return;
  context.waits.delete(wait.key);
  wait.retry();
}

/**
 * Forget the waits a staged attempt armed inside `key`: its output never reached
 * the screen, so a boundary in it has nothing to wake. The boundary's own wait is
 * keyed exactly `key`, so only what the attempt nested is dropped.
 */
function dropStagedWaits<Root, Instance>(
  context: RenderContext<Root, Instance>,
  key: string,
): void {
  const prefix = key + "/";
  for (const armed of [...context.waits.keys()]) {
    if (armed.startsWith(prefix)) context.waits.delete(armed);
  }
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
  const effectMark = context.effects === null ? 0 : context.effects.length;
  try {
    renderInScope(context, contentKey, () => {
      renderNode(context, props.children, parent);
    });
    acceptMarker(context, parent, "/$");
  } catch (thrown) {
    dropPendingProps(context, contentKey);
    // The attempt never stood, so the effects its content read are not owed.
    if (context.effects !== null) context.effects.length = effectMark;
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
    const fallback = renderIntoStagingRoot(context, fallbackKey, props.fallback);
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
    // Whatever the attempt armed inside its content is discarded with it.
    dropStagedWaits(context, contentKey);
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
  const effectMark = context.effects === null ? 0 : context.effects.length;
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
      dropStagedWaits(context, contentKey);
      // The attempt did not stand, so the effects it read are not owed.
      if (context.effects !== null) context.effects.length = effectMark;
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
  try {
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
  } finally {
    // No pass sits above a retry, so it commits whatever it rendered itself.
    context.flushEffects();
  }
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
  commitStagedRoot(context, parent, staged, end);
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
  /** Render `element` into the root, patching the tree a previous pass left. */
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
  /** Only a host that patches and a driver that can re-render support updates. */
  const canUpdate = options.rerender !== undefined && (host.patch ?? null) !== null;
  /** Only a target that keeps its tree can run effects; a serializer cannot. */
  const canRunEffects = (host.patch ?? null) !== null;
  /** Components whose queued state still has to be applied. */
  const dirty = new Set<ComponentInstance>();
  /** Components that dispatched while a pass was running; that pass may cover them. */
  const queuedDuringPass = new Set<ComponentInstance>();
  let flushing = false;

  const context: RenderContext<Root, Instance> = {
    host,
    instances: new Map(),
    rendered: new Set(),
    scope: { key: "root", index: 0, depth: 0 },
    rerender: options.rerender ?? noop,
    onSuspend: options.onSuspend ?? noop,
    boundaries: options.boundaries ?? null,
    onError: options.onError,
    hydrating: false,
    patch: host.patch ?? null,
    hydration: host.hydration ?? null,
    deferred: null,
    pendingProps: null,
    pass: 0,
    armed: new Set(),
    waits: new Map(),
    schedule,
    stagedRanges: new Map(),
    clientBoundaries: new Map(),
    rendering: false,
    afterPass,
    effects: canRunEffects ? [] : null,
    cleanups: [],
    flushEffects,
  };

  /** Effects a target never runs (a serializer) are dropped as they are read. */
  const effects = context.effects;
  /** The timer the passive phase waits on; `null` when nothing is owed. */
  let passiveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Run one phase of what the commit recorded: every cleanup, then every create. */
  function runEffects(layout: boolean): void {
    if (effects === null) return;

    // Take the phase's work first, so a callback that renders cannot shuffle it.
    const owed: PendingEffect[] = [];
    for (let i = 0; i < effects.length;) {
      const pending = effects[i];
      if (pending.hook.layout !== layout) {
        i++;
        continue;
      }
      effects.splice(i, 1);
      // Unmounted before this phase ran: the tree never committed it.
      if (context.instances.get(pending.instance.key) !== pending.instance) continue;
      if (pending.hook.ran && areDepsEqual(pending.hook.committedDeps, pending.deps)) continue;
      owed.push(pending);
    }

    const cleanups: EffectHook[] = [];
    for (let i = 0; i < context.cleanups.length;) {
      const hook = context.cleanups[i];
      if (hook.layout !== layout) {
        i++;
        continue;
      }
      context.cleanups.splice(i, 1);
      cleanups.push(hook);
    }

    // As in React, nothing is created until the phase has dropped every effect
    // it owns, so no cleanup ever sees a half-updated tree.
    for (const hook of cleanups) destroyEffect(hook);
    for (const pending of owed) destroyEffect(pending.hook);

    // The pass recorded effects children first, so the creates already run bottom-up.
    for (const pending of owed) {
      const hook = pending.hook;
      hook.ran = true;
      hook.committedDeps = pending.deps === undefined ? undefined : pending.deps.slice();
      const destroy = pending.create();
      hook.destroy = typeof destroy === "function" ? destroy : undefined;
    }
  }

  /** Drop one hook's cleanup; a component that left the tree runs it one last time. */
  function destroyEffect(hook: EffectHook): void {
    hook.ran = false;
    const destroy = hook.destroy;
    hook.destroy = undefined;
    destroy?.();
  }

  /** Whether a phase still owes passive work, so a timer is worth scheduling. */
  function owesPassive(): boolean {
    if (effects === null) return false;
    return (
      effects.some((pending) => !pending.hook.layout) ||
      context.cleanups.some((hook) => !hook.layout)
    );
  }

  /**
   * Passive effects wait for the next task, so the commit finishes and the
   * browser gets to paint before anything runs.
   */
  function schedulePassive(): void {
    if (passiveTimer !== null || !owesPassive()) return;
    passiveTimer = setTimeout(() => {
      passiveTimer = null;
      runEffects(false);
      afterPass();
    }, 0);
  }

  /**
   * A passive phase is a commit of its own: a render that starts while one is
   * owed has to let it finish first, or the effect would read the newer tree.
   */
  function flushPassiveEffects(): void {
    if (context.rendering || passiveTimer === null) return;
    clearTimeout(passiveTimer);
    passiveTimer = null;
    runEffects(false);
  }

  /**
   * Work nested inside a pass leaves its effects to the pass that started it,
   * so only the outermost frame of a commit runs them.
   */
  function flushEffects(): void {
    if (context.rendering || effects === null) return;
    runEffects(true);
    schedulePassive();
  }

  function schedule(instance: ComponentInstance): void {
    if (!canUpdate) return;
    dirty.add(instance);
    if (flushing || context.rendering) {
      // The running pass may already render this component, so decide afterwards.
      queuedDuringPass.add(instance);
      return;
    }
    flushUpdates();
  }

  /** The queued component closest to the root, so an ancestor pass absorbs its descendants. */
  function shallowest(): ComponentInstance {
    let next: ComponentInstance | null = null;
    for (const candidate of dirty) {
      if (next === null || candidate.depth < next.depth) next = candidate;
    }
    return next as ComponentInstance;
  }

  /** Keep only work the pass did not apply; the rest is already on screen. */
  function settleQueued(): void {
    for (const instance of [...dirty]) {
      if (queuedDuringPass.has(instance)) continue;
      const current = context.instances.get(instance.key) === instance;
      if (!current || context.rendered.has(instance.key)) dirty.delete(instance);
    }
    queuedDuringPass.clear();
  }

  function flushUpdates(): void {
    if (!canUpdate) return;
    flushing = true;
    try {
      // A render may only start once the passive phase it follows has run.
      flushPassiveEffects();
      while (dirty.size > 0) {
        const instance = shallowest();
        dirty.delete(instance);
        const result = renderComponentUpdate(context, instance);
        if (result === "fallback" || result === "suspended") {
          // Only a root pass can find output whose range was never recorded, or
          // reach the boundary that has to catch a suspension.
          options.rerender?.();
          continue;
        }
        settleQueued();
      }
    } finally {
      flushing = false;
    }
  }

  /** Let a scoped retry hand queued work back to the scheduler. */
  function afterPass(): void {
    settleQueued();
    if (!flushing && dirty.size > 0) flushUpdates();
  }

  return {
    render(element) {
      // The passive phase of the previous commit belongs before this pass.
      flushPassiveEffects();
      context.rendering = true;
      let rendered = false;
      try {
        const root = host.createRoot();
        renderPass(context, element, root);
        rendered = true;
        return root;
      } finally {
        context.rendering = false;
        // A pass that threw left no tree, so nothing it read is owed.
        if (!rendered && effects !== null) effects.length = 0;
        if (rendered) flushEffects();
        afterPass();
      }
    },
    hydrate(element, root) {
      const hydration = context.hydration;
      if (hydration === null) throw new Error("This target cannot hydrate.");

      // The passive phase of the previous commit belongs before this pass.
      flushPassiveEffects();

      /** Settled retries wait until the pass stops claiming nodes. */
      const suspended: DeferredSuspension[] = [];
      /** Listeners and attributes are applied only if this attempt commits. */
      const queued: PendingProperties<Instance>[] = [];
      let committed = false;
      let rendered = false;

      context.rendering = true;
      try {
        hydration.begin(root);
        context.hydrating = true;
        context.deferred = suspended;
        context.pendingProps = queued;
        try {
          try {
            renderPass(context, element, root);
            committed = true;
            rendered = true;
          } catch (error) {
            if (!(error instanceof HydrationMismatchError)) throw error;

            // The markup cannot be lined up with the tree, so the client takes
            // the root over. Hooks and host work from the attempt must not
            // survive, and neither do the retries it armed or the ranges it
            // staged.
            suspended.length = 0;
            queued.length = 0;
            context.instances.clear();
            context.rendered.clear();
            context.stagedRanges.clear();
            if (effects !== null) effects.length = 0;
            context.hydrating = false;
            hydration.clear(root);
            renderPass(context, element, root);
            rendered = true;
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
      } finally {
        context.rendering = false;
        if (!rendered && effects !== null) effects.length = 0;
        if (rendered) flushEffects();
        afterPass();
      }
    },
    reset() {
      // The tree is going away, so whatever it ran owes a cleanup now.
      if (effects !== null) {
        // A passive phase nobody has run yet dies with the tree it belongs to.
        if (passiveTimer !== null) clearTimeout(passiveTimer);
        passiveTimer = null;
        effects.length = 0;
        for (const instance of context.instances.values()) {
          for (const hook of instance.hooks) {
            const effect = hook.effect;
            if (effect !== undefined && effect.ran) context.cleanups.push(effect);
          }
        }
        runEffects(true);
        runEffects(false);
      }
      dirty.clear();
      queuedDuringPass.clear();
      context.instances.clear();
      context.rendered.clear();
      context.clientBoundaries.clear();
      context.armed.clear();
      context.waits.clear();
      context.stagedRanges.clear();
      context.patch?.reset();
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
