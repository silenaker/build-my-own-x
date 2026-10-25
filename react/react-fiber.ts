/**
 * The Fiber reconciler behind `createRoot`.
 *
 * React's architecture has two trees: the `current` tree that is on screen and
 * a `workInProgress` tree built during render. Every fiber points at its other
 * version through `alternate`, so a pass reuses the objects (and the hooks on
 * them) instead of rebuilding state, and the alternate only replaces the
 * current tree once the whole render finished.
 *
 * Work happens in two phases:
 *
 * - render: `beginWork` / `completeWork` walk the tree top-down and then
 *   bottom-up, building fibers, running components and collecting flags. The
 *   phase never moves a node that is already in the document, so a render can
 *   be thrown away (a suspended subtree) without touching the screen.
 * - commit: the flags decide the mutations (delete, place, update), then the
 *   layout effects run, then the tree is published as `current`.
 *
 * `createFiberDomRoot` uses this module. `createRoot` and `hydrateRoot` still
 * use the streaming walker in `react-dom-core.ts`, which mirrors Fizz's design
 * and hydrates the markup Fizz emits.
 */

import {
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_SUSPENSE_TYPE,
  ReactSharedInternals,
  isLazyWrapper,
  type Dispatcher,
  type LazyWrapper,
} from "./react.ts";
import { normalizeProperties, type NormalizedProperties } from "./react-dom-core.ts";
import { isThenable, type Any, type Thenable } from "./shared.ts";

const FunctionComponent = 0;
const HostRoot = 3;
const HostComponent = 5;
const HostText = 6;
const Fragment = 7;
const SuspenseComponent = 13;

/** What a commit has to do to one fiber. */
const NoFlags = 0;
const Placement = 1 << 0;
const Update = 1 << 1;
const Deletion = 1 << 2;
const LayoutEffect = 1 << 3;
const PassiveEffect = 1 << 4;
const ContentReset = 1 << 5;

/**
 * A single sync lane. Every update renders at once, so a lane only has to mark
 * *which* fibers are dirty; `childLanes` is what lets an ancestor skip its own
 * render while still descending to the child that changed.
 */
const NoLanes = 0;
const SyncLane = 1;

type Lanes = number;

interface Fiber {
  tag: number;
  /** The resolved element type: a tag string, a component, or `null`. */
  type: Any;
  /** The type the element was created with, before lazy unwrapping. */
  elementType: Any;
  key: string | null;
  /** Position among its siblings, used to match unkeyed children. */
  index: number;
  /** The DOM node of a host fiber, or the root object of `HostRoot`. */
  stateNode: Any;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  pendingProps: Any;
  memoizedProps: Any;
  /** First hook of a function component, or a boundary marker. */
  memoizedState: Any;
  updateQueue: Any;
  flags: number;
  subtreeFlags: number;
  deletions: Fiber[] | null;
  lanes: Lanes;
  childLanes: Lanes;
  /** Set on `<Suspense>` fibers; shared by both alternates of one boundary. */
  boundaryRecord?: BoundaryRecord;
  /** True once this attempt captured a thenable, so it is not captured twice. */
  captured?: boolean;
  /** Hook calls in the render in progress, for the "fewer hooks" check. */
  hookCounter: number;
}

interface RootQueue {
  pending: Any[];
}

export interface FiberRoot {
  container: Element;
  document: Document;
  current: Fiber;
  pendingLanes: Lanes;
  isFlushing: boolean;
  needsFlush: boolean;
  mounted: boolean;
  /** Effects a finished commit still owes the passive phase. */
  passive: PassiveWork | null;
  passiveTimer: Any;
}

interface PassiveWork {
  destroys: Hook[];
  creates: Hook[];
}

interface ElementDescriptor {
  kind: "element";
  key: string | null;
  elementType: Any;
  pendingProps: Any;
}

interface TextDescriptor {
  kind: "text";
  key: string | null;
  text: string;
}

type ChildDescriptor = ElementDescriptor | TextDescriptor;

function describeChild(value: Any): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return "undefined";
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
  const node = value as Any;
  if (node.$$typeof === REACT_ELEMENT_TYPE) return "a React element";
  if (isLazyWrapper(node)) return "a lazy element";
  return "an object";
}

function resolveLazy(lazy: LazyWrapper): Any {
  if (typeof lazy._init !== "function") {
    throw new Error("Invalid lazy element type: missing `_init`.");
  }
  // A pending `_init` throws its thenable: the nearest boundary has to see it.
  return lazy._init();
}

function normalizeChildren(value: Any, out: ChildDescriptor[] = []): ChildDescriptor[] {
  if (Array.isArray(value)) {
    for (const child of value) normalizeChildren(child, out);
    return out;
  }
  if (value === null || value === undefined || typeof value === "boolean") return out;

  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "bigint") {
    out.push({ kind: "text", key: null, text: String(value) });
    return out;
  }
  if (kind === "symbol") throw new Error("Symbols are not valid as a React child.");
  if (kind === "function") throw new Error("Functions are not valid as a React child.");

  let node = value;
  while (isLazyWrapper(node)) node = resolveLazy(node);

  if (node.$$typeof === REACT_ELEMENT_TYPE) {
    let type = node.type;
    while (isLazyWrapper(type)) type = resolveLazy(type);
    out.push({
      kind: "element",
      key: node.key ?? null,
      elementType: type,
      pendingProps: node.props ?? {},
    });
    return out;
  }
  throw new Error("Objects are not valid as a React child (found: " + describeChild(node) + ").");
}

function fiberTagFor(type: Any): number {
  if (type === REACT_FRAGMENT_TYPE) return Fragment;
  if (type === REACT_SUSPENSE_TYPE) return SuspenseComponent;
  if (typeof type === "string") return HostComponent;
  if (typeof type === "function") return FunctionComponent;
  throw new Error(
    "Element type is invalid: expected a string (a host tag) or a function (a component) but got: " +
      describeChild(type) +
      ".",
  );
}

function createFiber(tag: number, pendingProps: Any, key: string | null, type: Any): Fiber {
  return {
    tag,
    type,
    elementType: type,
    key,
    index: 0,
    stateNode: null,
    return: null,
    child: null,
    sibling: null,
    alternate: null,
    pendingProps,
    memoizedProps: null,
    memoizedState: null,
    updateQueue: null,
    flags: NoFlags,
    subtreeFlags: NoFlags,
    deletions: null,
    lanes: NoLanes,
    childLanes: NoLanes,
    hookCounter: 0,
  };
}

function fiberFromDescriptor(descriptor: ChildDescriptor, index: number): Fiber {
  const fiber =
    descriptor.kind === "text"
      ? createFiber(HostText, descriptor.text, null, null)
      : createFiber(
          fiberTagFor(descriptor.elementType),
          descriptor.pendingProps,
          descriptor.key,
          descriptor.elementType,
        );
  fiber.index = index;
  return fiber;
}

function createWorkInProgress(current: Fiber, pendingProps: Any): Fiber {
  let workInProgress = current.alternate;

  if (workInProgress === null) {
    workInProgress = createFiber(current.tag, pendingProps, current.key, current.elementType);
    workInProgress.type = current.type;
    workInProgress.stateNode = current.stateNode;
    workInProgress.alternate = current;
    current.alternate = workInProgress;
  } else {
    workInProgress.pendingProps = pendingProps;
    workInProgress.type = current.type;
    workInProgress.elementType = current.elementType;
    workInProgress.key = current.key;
    workInProgress.stateNode = current.stateNode;
    workInProgress.flags = NoFlags;
    workInProgress.subtreeFlags = NoFlags;
    workInProgress.deletions = null;
    workInProgress.captured = false;
    workInProgress.hookCounter = 0;
  }

  // A bailout keeps the subtree by sharing it, so the pointers start as copies.
  workInProgress.child = current.child;
  workInProgress.sibling = current.sibling;
  workInProgress.index = current.index;
  workInProgress.memoizedProps = current.memoizedProps;
  workInProgress.memoizedState = current.memoizedState;
  workInProgress.updateQueue = current.updateQueue;
  workInProgress.lanes = current.lanes;
  workInProgress.childLanes = current.childLanes;
  workInProgress.boundaryRecord = current.boundaryRecord;

  return workInProgress;
}

function cloneChildFibers(workInProgress: Fiber): void {
  const current = workInProgress.alternate;
  if (current === null || current.child === null) return;

  let oldChild: Fiber = current.child;
  let newChild = createWorkInProgress(oldChild, oldChild.pendingProps);
  newChild.return = workInProgress;
  workInProgress.child = newChild;

  while (oldChild.sibling !== null) {
    oldChild = oldChild.sibling;
    const sibling = createWorkInProgress(oldChild, oldChild.pendingProps);
    sibling.return = workInProgress;
    newChild.sibling = sibling;
    newChild = sibling;
  }
  newChild.sibling = null;
}

// ---- Hooks -----------------------------------------------------------------

const NoEffectTag = 0;
const LayoutEffectTag = 1;
const PassiveEffectTag = 2;

interface StateUpdate {
  action: Any;
}

interface HookQueue {
  /** Actions dispatched since the last commit, in dispatch order. */
  pending: StateUpdate[];
  dispatch: ((action: Any) => void) | null;
  /** The fiber that most recently rendered this hook, so dispatch targets it. */
  fiber: Fiber | null;
}

interface Hook {
  memoizedState: Any;
  /** State before `pending` is replayed; only advances when a render commits. */
  baseState: Any;
  queue: HookQueue | null;
  next: Hook | null;
  /** How many queued actions this render consumed, cleared on commit. */
  processed: number;
  /** `NoEffectTag`, `LayoutEffectTag` or `PassiveEffectTag`. */
  effectTag: number;
  /** Whether this render is the hook's first. */
  isNew: boolean;
  create: (() => void | (() => void)) | null;
  destroy: (() => void) | null;
  /** Deps the last commit ran with. */
  deps: unknown[] | undefined;
  /** Deps this render read; none of them is committed until the phase runs. */
  nextDeps: unknown[] | undefined;
}

function createHook(): Hook {
  return {
    memoizedState: null,
    baseState: null,
    queue: null,
    next: null,
    processed: 0,
    effectTag: NoEffectTag,
    isNew: true,
    create: null,
    destroy: null,
    deps: undefined,
    nextDeps: undefined,
  };
}

function cloneHook(hook: Hook): Hook {
  return {
    memoizedState: hook.memoizedState,
    baseState: hook.baseState,
    queue: hook.queue,
    next: null,
    processed: 0,
    effectTag: NoEffectTag,
    isNew: false,
    create: null,
    destroy: hook.destroy,
    deps: hook.deps,
    nextDeps: undefined,
  };
}

let currentlyRenderingFiber: Fiber | null = null;
let workInProgressHook: Hook | null = null;
let currentHook: Hook | null = null;

function updateWorkInProgressHook(): Hook {
  const fiber = currentlyRenderingFiber;
  if (fiber === null) {
    throw new Error("Invalid hook call. Hooks can only be called inside a component's body.");
  }

  fiber.hookCounter++;

  const nextCurrentHook: Hook | null =
    workInProgressHook === null
      ? ((fiber.alternate?.memoizedState as Hook | null) ?? null)
      : (currentHook?.next ?? null);

  const hook = nextCurrentHook === null ? createHook() : cloneHook(nextCurrentHook);

  if (workInProgressHook === null) fiber.memoizedState = hook;
  else workInProgressHook.next = hook;

  workInProgressHook = hook;
  currentHook = nextCurrentHook;
  return hook;
}

function areDepsEqual(previous: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (previous === undefined || next === undefined) return false;
  if (previous.length !== next.length) return false;
  for (let i = 0; i < previous.length; i++) {
    if (!Object.is(previous[i], next[i])) return false;
  }
  return true;
}

function dispatchAction(queue: HookQueue, action: Any): void {
  queue.pending.push({ action });
  const fiber = queue.fiber;
  if (fiber === null) return;
  const root = getRootOfFiber(fiber);
  if (root === null || !root.mounted) return;
  markUpdateLane(fiber);
  scheduleFlush(root);
}

function mountState<S>(hook: Hook, initialState: S | (() => S)): [S, (action: Any) => void] {
  const state = typeof initialState === "function" ? (initialState as () => S)() : initialState;
  hook.memoizedState = state;
  hook.baseState = state;
  const queue: HookQueue = { pending: [], dispatch: null, fiber: currentlyRenderingFiber };
  queue.dispatch = (action: Any) => dispatchAction(queue, action);
  hook.queue = queue;
  return [state, queue.dispatch];
}

function updateState<S>(hook: Hook): [S, (action: Any) => void] {
  const queue = hook.queue as HookQueue;
  queue.fiber = currentlyRenderingFiber;

  if (queue.pending.length > 0) {
    let state = hook.baseState as S;
    for (const update of queue.pending) {
      state =
        typeof update.action === "function"
          ? (update.action as (previous: S) => S)(state)
          : (update.action as S);
    }
    hook.memoizedState = state;
  }
  hook.processed = queue.pending.length;
  return [hook.memoizedState as S, queue.dispatch as (action: Any) => void];
}

function mountReducer<S, A>(
  hook: Hook,
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init: ((arg: S) => S) | undefined,
): [S, (action: A) => void] {
  const state = init !== undefined ? init(initialArg) : initialArg;
  hook.memoizedState = state;
  hook.baseState = state;
  const queue: HookQueue & { reducer: (state: S, action: A) => S } = {
    pending: [],
    dispatch: null,
    fiber: currentlyRenderingFiber,
    reducer,
  };
  queue.dispatch = (action: Any) => dispatchAction(queue, action);
  hook.queue = queue;
  return [state, queue.dispatch as (action: A) => void];
}

function updateReducer<S, A>(hook: Hook): [S, (action: A) => void] {
  const queue = hook.queue as HookQueue;
  queue.fiber = currentlyRenderingFiber;

  if (queue.pending.length > 0) {
    const reducer = (queue as Any).reducer as (state: S, action: A) => S;
    let state = hook.baseState as S;
    for (const update of queue.pending) {
      state = reducer(state, update.action as A);
    }
    hook.memoizedState = state;
  }
  hook.processed = queue.pending.length;
  return [hook.memoizedState as S, queue.dispatch as (action: A) => void];
}

function readState<S>(initialState: S | (() => S)): [S, (action: Any) => void] {
  const hook = updateWorkInProgressHook();
  return hook.queue === null ? mountState(hook, initialState) : updateState<S>(hook);
}

function readReducer<S, A>(
  reducer: (state: S, action: A) => S,
  initialArg: S,
  init?: (arg: S) => S,
): [S, (action: A) => void] {
  const hook = updateWorkInProgressHook();
  return hook.queue === null
    ? mountReducer(hook, reducer, initialArg, init)
    : updateReducer<S, A>(hook);
}

function readRef<T>(initialValue: T): { current: T } {
  const hook = updateWorkInProgressHook();
  if (hook.isNew) hook.memoizedState = { current: initialValue };
  return hook.memoizedState as { current: T };
}

function readMemo<T>(factory: () => T, deps: unknown[] | undefined): T {
  const hook = updateWorkInProgressHook();
  if (hook.isNew || !areDepsEqual(hook.deps, deps)) {
    hook.memoizedState = factory();
    hook.deps = deps === undefined ? undefined : deps.slice();
  }
  return hook.memoizedState as T;
}

function readEffect(
  create: () => void | (() => void),
  deps: unknown[] | undefined,
  tag: typeof LayoutEffectTag | typeof PassiveEffectTag,
): void {
  const fiber = currentlyRenderingFiber;
  if (fiber === null) {
    throw new Error("Invalid hook call. Hooks can only be called inside a component's body.");
  }
  const hook = updateWorkInProgressHook();

  hook.effectTag = tag;
  hook.create = create;
  hook.nextDeps = deps;

  if (hook.isNew || !areDepsEqual(hook.deps, deps)) {
    fiber.flags |= tag === LayoutEffectTag ? LayoutEffect : PassiveEffect;
  }
}

const hookDispatcher: Dispatcher = {
  useState: readState,
  useReducer: readReducer,
  useRef: readRef,
  useMemo: readMemo,
  useEffect: (create, deps) => readEffect(create, deps, PassiveEffectTag),
  useLayoutEffect: (create, deps) => readEffect(create, deps, LayoutEffectTag),
};

/**
 * Run a component with its hooks bound to `workInProgress`. A second call on
 * the same queue is the update path; the checks mirror React's rules.
 */
function renderWithHooks(workInProgress: Fiber, component: Any, props: Any): Any {
  const previousDispatcher = ReactSharedInternals.currentDispatcher;
  const previousFiber = currentlyRenderingFiber;
  const previousHook = workInProgressHook;
  const previousCurrentHook = currentHook;

  currentlyRenderingFiber = workInProgress;
  workInProgress.memoizedState = null;
  workInProgress.hookCounter = 0;
  workInProgressHook = null;
  currentHook = null;
  ReactSharedInternals.currentDispatcher = hookDispatcher;

  let output: Any;
  try {
    output = component(props);
  } finally {
    ReactSharedInternals.currentDispatcher = previousDispatcher;
    currentlyRenderingFiber = previousFiber;
    workInProgressHook = previousHook;
    currentHook = previousCurrentHook;
  }

  const used = workInProgress.hookCounter;
  let mounted = 0;
  let hook = workInProgress.alternate?.memoizedState as Hook | null | undefined;
  while (hook !== null && hook !== undefined) {
    mounted++;
    hook = hook.next;
  }
  if (used < mounted) {
    throw new Error(
      "Rendered fewer hooks than expected. This is probably caused by an early return statement.",
    );
  }

  return output;
}

// ---- Boundaries ------------------------------------------------------------

/**
 * One `<Suspense>` boundary, shared by both fiber alternates. The fiber objects
 * are recreated on every pass; the record keeps the identity a retry needs.
 */
interface BoundaryRecord {
  /** The fiber of the boundary. */
  fiber: Fiber | null;
  /** True while the boundary is on screen. */
  mounted: boolean;
  /** The thenable the boundary is waiting on, or `null` once content committed. */
  wait: Thenable | null;
  /** The last committed content, kept alive while the fallback is on screen. */
  stash: Fiber | null;
}

function createBoundaryRecord(): BoundaryRecord {
  return { fiber: null, mounted: false, wait: null, stash: null };
}

const waiters = new Map<Thenable, Set<BoundaryRecord>>();

/** Fibers a suspended boundary keeps: the commit that shows the fallback leaves them be. */
const retained = new Set<Fiber>();

function subscribe(record: BoundaryRecord, thenable: Thenable): void {
  let bucket = waiters.get(thenable);
  const first = bucket === undefined;
  if (bucket === undefined) {
    bucket = new Set();
    waiters.set(thenable, bucket);
  }
  if (bucket.has(record)) return;
  bucket.add(record);
  if (!first) return;

  const ping = (): void => {
    const current = waiters.get(thenable);
    if (current === undefined) return;
    // Drop the bucket first: a retry may suspend on the same thenable again and
    // subscribe a fresh one while this settlement is being delivered.
    waiters.delete(thenable);
    // Several boundaries can wait on one thenable; each runs its own retry.
    for (const pending of current) pingBoundary(pending, thenable);
  };
  // A rejection pings too: `use()` throws the reason on the next attempt.
  thenable.then(ping, ping);
}

/**
 * Drop a boundary that left the tree from the thenable it was waiting on. It can
 * never retry, and an unsettled thenable would otherwise keep the record (and
 * every fiber it still points at) alive.
 */
function unsubscribe(record: BoundaryRecord): void {
  const thenable = record.wait;
  if (thenable === null) return;
  const bucket = waiters.get(thenable);
  if (bucket === undefined) return;
  bucket.delete(record);
  if (bucket.size === 0) waiters.delete(thenable);
}

/** Wake one boundary: mark its lane and render, ancestors bail out on the way. */
function pingBoundary(record: BoundaryRecord, thenable: Thenable): void {
  if (!record.mounted || record.wait === null || record.wait !== thenable) return;
  const fiber = record.fiber;
  if (fiber === null) return;
  const root = getRootOfFiber(fiber);
  if (root === null || !root.mounted) return;

  markUpdateLane(fiber);
  scheduleFlush(root);
}

/** Keep a suspended boundary's committed content, and hide its boundaries. */
function retainSubtree(fiber: Fiber): void {
  retained.add(fiber);
  if (fiber.tag === SuspenseComponent && fiber.boundaryRecord !== undefined) {
    fiber.boundaryRecord.mounted = false;
  }
  let child = fiber.child;
  while (child !== null) {
    retainSubtree(child);
    child = child.sibling;
  }
}

// ---- Work loop -------------------------------------------------------------

let renderLanes: Lanes = SyncLane;

function getRootOfFiber(fiber: Fiber | null): FiberRoot | null {
  let node = fiber;
  while (node !== null) {
    if (node.tag === HostRoot) return node.stateNode as FiberRoot;
    node = node.return;
  }
  return null;
}

function markUpdateLane(fiber: Fiber): void {
  // Dispatch closures keep the fiber the hook was mounted on, which may now be
  // the alternate: both sides of every pair have to carry the lane.
  fiber.lanes |= SyncLane;
  if (fiber.alternate !== null) fiber.alternate.lanes |= SyncLane;

  let node = fiber.return;
  while (node !== null) {
    node.childLanes |= SyncLane;
    if (node.alternate !== null) node.alternate.childLanes |= SyncLane;
    node = node.return;
  }
  const root = getRootOfFiber(fiber);
  if (root !== null) root.pendingLanes |= SyncLane;
}

function performUnitOfWork(unitOfWork: Fiber): Fiber | null {
  const next = beginWork(unitOfWork);
  unitOfWork.memoizedProps = unitOfWork.pendingProps;
  if (next === null) return completeUnitOfWork(unitOfWork);
  return next;
}

function completeUnitOfWork(unitOfWork: Fiber): Fiber | null {
  let completed = unitOfWork;
  while (true) {
    completeWork(completed);
    if (completed.sibling !== null) return completed.sibling;
    if (completed.return !== null) {
      completed = completed.return;
      continue;
    }
    return null;
  }
}

function beginWork(workInProgress: Fiber): Fiber | null {
  switch (workInProgress.tag) {
    case HostRoot:
      return updateHostRoot(workInProgress);
    case FunctionComponent:
      return updateFunctionComponent(workInProgress);
    case HostComponent:
      return updateHostComponent(workInProgress);
    case HostText:
      workInProgress.lanes &= ~renderLanes;
      return null;
    case Fragment:
      return updateFragment(workInProgress);
    case SuspenseComponent:
      return updateSuspenseComponent(workInProgress);
    default:
      throw new Error("Unknown fiber tag: " + workInProgress.tag);
  }
}

function updateHostRoot(workInProgress: Fiber): Fiber | null {
  workInProgress.lanes &= ~renderLanes;
  const queue = workInProgress.updateQueue as RootQueue;
  let element = workInProgress.memoizedState;
  if (queue.pending.length > 0) {
    element = queue.pending[queue.pending.length - 1];
    queue.pending = [];
  }
  workInProgress.memoizedState = element;
  reconcileChildren(
    workInProgress,
    workInProgress.alternate?.child ?? null,
    normalizeChildren(element),
  );
  return workInProgress.child;
}

function updateFunctionComponent(workInProgress: Fiber): Fiber | null {
  const current = workInProgress.alternate;
  const hasOwnLane = (workInProgress.lanes & renderLanes) !== 0;

  if (current !== null && !hasOwnLane && current.memoizedProps === workInProgress.pendingProps) {
    return bailoutOnAlreadyFinishedWork(workInProgress);
  }

  workInProgress.lanes &= ~renderLanes;
  const children = renderWithHooks(
    workInProgress,
    workInProgress.type,
    workInProgress.pendingProps,
  );
  reconcileChildren(workInProgress, current?.child ?? null, normalizeChildren(children));
  return workInProgress.child;
}

/**
 * Nothing in this fiber changed, but a descendant may have: clone the children
 * so the walk can reach it. The component itself is never invoked again, which
 * is what keeps a targeted update local.
 */
function bailoutOnAlreadyFinishedWork(workInProgress: Fiber): Fiber | null {
  workInProgress.lanes &= ~renderLanes;
  if ((workInProgress.childLanes & renderLanes) === 0) return null;
  cloneChildFibers(workInProgress);
  return workInProgress.child;
}

function updateHostComponent(workInProgress: Fiber): Fiber | null {
  workInProgress.lanes &= ~renderLanes;
  const props: Any = workInProgress.pendingProps ?? {};
  const current = workInProgress.alternate;

  if (props.dangerouslySetInnerHTML !== null && props.dangerouslySetInnerHTML !== undefined) {
    // The HTML owns the children, so the fiber has none to reconcile.
    workInProgress.child = null;
    return null;
  }
  if (
    current !== null &&
    current.child !== null &&
    current.memoizedProps?.dangerouslySetInnerHTML
  ) {
    // Switching back to children: the HTML has to go before they are placed.
    workInProgress.flags |= ContentReset;
  }

  reconcileChildren(workInProgress, current?.child ?? null, normalizeChildren(props.children));
  return workInProgress.child;
}

function updateFragment(workInProgress: Fiber): Fiber | null {
  workInProgress.lanes &= ~renderLanes;
  const props: Any = workInProgress.pendingProps ?? {};
  reconcileChildren(
    workInProgress,
    workInProgress.alternate?.child ?? null,
    normalizeChildren(props.children),
  );
  return workInProgress.child;
}

function updateSuspenseComponent(workInProgress: Fiber): Fiber | null {
  const current = workInProgress.alternate;
  const record = workInProgress.boundaryRecord ?? current?.boundaryRecord ?? createBoundaryRecord();
  workInProgress.boundaryRecord = record;
  record.fiber = workInProgress;

  const props: Any = workInProgress.pendingProps ?? {};
  const retry = (workInProgress.lanes & renderLanes) !== 0;
  if (retry) {
    workInProgress.lanes &= ~renderLanes;
    workInProgress.memoizedState = null;
  }

  const currentSuspended = current !== null && current.memoizedState !== null;
  let attemptContent = workInProgress.memoizedState === null;
  if (
    !attemptContent &&
    workInProgress.captured !== true &&
    current !== null &&
    current.memoizedProps !== props
  ) {
    // The parent rendered the boundary again with new props: a fresh attempt.
    // A boundary that already captured in this pass stays on its fallback, or
    // the re-entry would throw again and swallow the whole tree.
    attemptContent = true;
    workInProgress.memoizedState = null;
  }

  if (attemptContent) {
    if (currentSuspended && current !== null) {
      // The fallback is on screen; the content comes back from the stash so
      // hooks inside it keep their state, and the fallback goes away.
      if (current.child !== null) pushDeletions(workInProgress, current.child);
      reconcileChildren(workInProgress, record.stash, normalizeChildren(props.children));
      markChildrenForPlacement(workInProgress);
    } else {
      reconcileChildren(workInProgress, current?.child ?? null, normalizeChildren(props.children));
    }
    return workInProgress.child;
  }

  // Still suspended: the marker the capture recorded stays on the fiber, so the
  // commit knows what to subscribe to.
  reconcileChildren(workInProgress, current?.child ?? null, normalizeChildren(props.fallback));
  return workInProgress.child;
}

/** Nodes coming back from a stash were removed with the fallback: place them again. */
function markChildrenForPlacement(workInProgress: Fiber): void {
  let child = workInProgress.child;
  while (child !== null) {
    child.flags |= Placement;
    child = child.sibling;
  }
}

// ---- Reconciliation --------------------------------------------------------

function reconcileChildren(
  returnFiber: Fiber,
  oldFirstChild: Fiber | null,
  children: ChildDescriptor[],
): void {
  const oldByKey = new Map<string, Fiber>();
  const oldByIndex = new Map<number, Fiber>();
  let old = oldFirstChild;
  while (old !== null) {
    if (old.key !== null) oldByKey.set(old.key, old);
    else oldByIndex.set(old.index, old);
    old = old.sibling;
  }

  const used = new Set<Fiber>();
  returnFiber.child = null;
  let previous: Fiber | null = null;

  for (let index = 0; index < children.length; index++) {
    const descriptor = children[index];
    const match =
      descriptor.key !== null
        ? (oldByKey.get(descriptor.key) ?? null)
        : (oldByIndex.get(index) ?? null);

    let next: Fiber;
    if (match !== null && isCompatible(match, descriptor)) {
      used.add(match);
      const pendingProps = descriptor.kind === "text" ? descriptor.text : descriptor.pendingProps;
      next = createWorkInProgress(match, pendingProps);
      next.index = index;
      next.return = returnFiber;
      if (match.index !== index) next.flags |= Placement;
      retained.delete(match);
    } else {
      next = fiberFromDescriptor(descriptor, index);
      next.return = returnFiber;
      next.flags |= Placement;
    }

    next.sibling = null;
    if (previous === null) returnFiber.child = next;
    else previous.sibling = next;
    previous = next;
  }

  for (const fiber of oldByKey.values()) {
    if (!used.has(fiber)) pushDeletion(returnFiber, fiber);
  }
  for (const fiber of oldByIndex.values()) {
    if (!used.has(fiber)) pushDeletion(returnFiber, fiber);
  }
}

function isCompatible(fiber: Fiber, descriptor: ChildDescriptor): boolean {
  if (descriptor.kind === "text") return fiber.tag === HostText;
  if (fiber.tag === HostText) return false;
  return fiber.elementType === descriptor.elementType;
}

function pushDeletion(returnFiber: Fiber, fiber: Fiber): void {
  (returnFiber.deletions ??= []).push(fiber);
  returnFiber.flags |= Deletion;
}

function pushDeletions(returnFiber: Fiber, first: Fiber): void {
  let fiber: Fiber | null = first;
  while (fiber !== null) {
    pushDeletion(returnFiber, fiber);
    fiber = fiber.sibling;
  }
}

// ---- Completion ------------------------------------------------------------

function completeWork(workInProgress: Fiber): void {
  switch (workInProgress.tag) {
    case HostComponent: {
      const current = workInProgress.alternate;
      if (current !== null && workInProgress.stateNode !== null) {
        if (current.memoizedProps !== workInProgress.pendingProps) {
          workInProgress.flags |= Update;
        }
      } else {
        const root = getRootOfFiber(workInProgress);
        const document = root?.document ?? (workInProgress.stateNode as Document);
        const instance = document.createElement(workInProgress.type);
        workInProgress.stateNode = instance;
        workInProgress.flags |= Placement;
        setInitialProperties(instance, normalizeProperties(workInProgress.pendingProps ?? {}));
      }
      break;
    }
    case HostText: {
      const current = workInProgress.alternate;
      if (current !== null && workInProgress.stateNode !== null) {
        if (current.memoizedProps !== workInProgress.pendingProps) {
          workInProgress.flags |= Update;
        }
      } else {
        const root = getRootOfFiber(workInProgress);
        const document = root?.document ?? (workInProgress.stateNode as Document);
        workInProgress.stateNode = document.createTextNode(workInProgress.pendingProps ?? "");
        workInProgress.flags |= Placement;
      }
      break;
    }
    default:
      break;
  }
  bubbleProperties(workInProgress);
}

function bubbleProperties(workInProgress: Fiber): void {
  let subtreeFlags = NoFlags;
  let child = workInProgress.child;
  while (child !== null) {
    subtreeFlags |= child.flags | child.subtreeFlags;
    child = child.sibling;
  }
  workInProgress.subtreeFlags = subtreeFlags;
}

function handleThrowable(thrown: Any, source: Fiber): Fiber | null {
  if (!isThenable(thrown)) throw thrown;

  let boundary: Fiber | null = source;
  while (boundary !== null) {
    if (
      boundary.tag === SuspenseComponent &&
      boundary.captured !== true &&
      boundary.boundaryRecord !== undefined
    ) {
      break;
    }
    boundary = boundary.return;
  }
  if (boundary === null) {
    throw new Error(
      "A component suspended while rendering synchronously, but no <Suspense> boundary " +
        "was found. Await the tree first (e.g. `await deepAwait(root)`) before rendering it.",
    );
  }

  const record = boundary.boundaryRecord as BoundaryRecord;
  const current = boundary.alternate;
  const currentSuspended = current !== null && current.memoizedState !== null;

  // The content on screen is the only thing that can be reused by a retry, so
  // it is detached from the tree instead of being unmounted.
  if (!currentSuspended && current !== null && current.child !== null) {
    record.stash = current.child;
    retainSubtree(current.child);
  }

  record.wait = thrown;

  boundary.memoizedState = { suspended: true, thenable: thrown };
  boundary.captured = true;
  boundary.child = null;
  boundary.deletions = null;
  boundary.flags &= ~Deletion;
  return boundary;
}

// ---- Host mutation ---------------------------------------------------------

const attachedListeners = new WeakMap<Any, Map<string, Any>>();
const writtenHTML = new WeakMap<Any, string>();

function setInitialProperties(instance: Any, properties: NormalizedProperties): void {
  for (const [name, value] of properties.attributes) instance.setAttribute(name, value);
  if (properties.events.length > 0) {
    const listeners = new Map<string, Any>();
    for (const [type, listener] of properties.events) {
      instance.addEventListener(type, listener);
      listeners.set(type, listener);
    }
    attachedListeners.set(instance, listeners);
  }
  if (properties.innerHTML !== null) {
    instance.innerHTML = properties.innerHTML;
    writtenHTML.set(instance, properties.innerHTML);
  }
}

function updateProperties(instance: Any, properties: NormalizedProperties): void {
  const wanted = new Map(properties.attributes);
  for (const name of instance.getAttributeNames()) {
    if (!wanted.has(name)) instance.removeAttribute(name);
  }
  for (const [name, value] of wanted) {
    if (instance.getAttribute(name) !== value) instance.setAttribute(name, value);
  }

  const previous = (attachedListeners.get(instance) as Map<string, Any> | undefined) ?? new Map();
  const next = new Map<string, Any>(properties.events);
  for (const [type, listener] of previous) {
    if (next.get(type) !== listener) instance.removeEventListener(type, listener);
  }
  for (const [type, listener] of next) {
    if (previous.get(type) !== listener) instance.addEventListener(type, listener);
  }
  if (next.size > 0) attachedListeners.set(instance, next);
  else attachedListeners.delete(instance);

  if (properties.innerHTML !== null) {
    if (writtenHTML.get(instance) !== properties.innerHTML) {
      instance.innerHTML = properties.innerHTML;
      writtenHTML.set(instance, properties.innerHTML);
    }
  } else if (writtenHTML.has(instance)) {
    instance.innerHTML = "";
    writtenHTML.delete(instance);
  }
}

function isHostParent(fiber: Fiber): boolean {
  return fiber.tag === HostComponent || fiber.tag === HostRoot;
}

function getHostParent(fiber: Fiber): Any {
  let parent = fiber.return;
  while (parent !== null) {
    if (parent.tag === HostComponent) return parent.stateNode;
    if (parent.tag === HostRoot) return (parent.stateNode as FiberRoot).container;
    parent = parent.return;
  }
  throw new Error("A host node was committed without a host parent.");
}

/**
 * The next node that is already in the document after `fiber`, so a placement
 * can land before it. Siblings that are still waiting for their own placement
 * are skipped: they will be inserted later, in order.
 */
function getHostSibling(fiber: Fiber): Any {
  let node: Fiber = fiber;
  outer: while (true) {
    while (node.sibling === null) {
      if (node.return === null || isHostParent(node.return)) return null;
      node = node.return;
    }
    node = node.sibling;
    while (node.tag !== HostComponent && node.tag !== HostText) {
      if ((node.flags & Placement) !== NoFlags) continue outer;
      if (node.child === null) continue outer;
      node = node.child;
    }
    if ((node.flags & Placement) === NoFlags) return node.stateNode;
  }
}

function insertHostNodes(parent: Any, fiber: Fiber, before: Any): void {
  if (fiber.tag === HostComponent || fiber.tag === HostText) {
    const node = fiber.stateNode;
    // A placement can be flagged on a component and on the host nodes inside
    // it; the node that is already in place must not move again.
    if (node.parentNode !== parent || node.nextSibling !== before) {
      parent.insertBefore(node, before);
    }
    return;
  }
  let child = fiber.child;
  while (child !== null) {
    insertHostNodes(parent, child, before);
    child = child.sibling;
  }
}

function commitPlacement(fiber: Fiber): void {
  const parent = getHostParent(fiber);
  const before = getHostSibling(fiber);
  insertHostNodes(parent, fiber, before);
}

function commitUpdate(fiber: Fiber): void {
  const instance = fiber.stateNode;
  if (fiber.tag === HostText) {
    if (instance.data !== fiber.pendingProps) instance.data = fiber.pendingProps;
    return;
  }
  updateProperties(instance, normalizeProperties(fiber.pendingProps ?? {}));
}

/** Drop one subtree: its cleanups run, then its nodes leave the document. */
function commitDeletion(fiber: Fiber): void {
  unmountSubtree(fiber);
  removeHostNodes(fiber);
}

function unmountSubtree(fiber: Fiber): void {
  if (fiber.tag === SuspenseComponent && fiber.boundaryRecord !== undefined) {
    const record = fiber.boundaryRecord;
    record.mounted = false;
    unsubscribe(record);
  }

  // A boundary kept this subtree alive behind its fallback: the nodes go with
  // the fallback, but the hooks keep their state for the retry.
  const keep = retained.delete(fiber);

  if (fiber.tag === FunctionComponent && !keep) {
    let hook = fiber.memoizedState as Hook | null;
    while (hook !== null) {
      if (hook.effectTag !== NoEffectTag && hook.destroy !== null) {
        const destroy = hook.destroy;
        hook.destroy = null;
        destroy();
      }
      hook = hook.next;
    }
  }

  let child = fiber.child;
  while (child !== null) {
    unmountSubtree(child);
    child = child.sibling;
  }
}

function removeHostNodes(fiber: Fiber): void {
  if (fiber.tag === HostComponent || fiber.tag === HostText) {
    const node = fiber.stateNode;
    if (node.parentNode !== null) node.parentNode.removeChild(node);
    return;
  }
  let child = fiber.child;
  while (child !== null) {
    removeHostNodes(child);
    child = child.sibling;
  }
}

// ---- Commit ----------------------------------------------------------------

interface CommitLists {
  layoutDestroys: Hook[];
  layoutCreates: Hook[];
  passiveDestroys: Hook[];
  passiveCreates: Hook[];
}

function commitMutationEffects(fiber: Fiber, lists: CommitLists): void {
  // Switch back from HTML before any child is placed into the element.
  if ((fiber.flags & ContentReset) !== NoFlags && fiber.tag === HostComponent) {
    fiber.stateNode.innerHTML = "";
    writtenHTML.delete(fiber.stateNode);
  }

  // Old nodes leave before the new ones are placed, so siblings resolve.
  if ((fiber.flags & Deletion) !== NoFlags && fiber.deletions !== null) {
    for (const deleted of fiber.deletions) commitDeletion(deleted);
    fiber.deletions = null;
  }

  {
    let child = fiber.child;
    while (child !== null) {
      commitMutationEffects(child, lists);
      child = child.sibling;
    }
  }

  // The commit is what makes the updates this render consumed permanent. A
  // discarded attempt never gets here, so its queue still owes them.
  if (fiber.tag === FunctionComponent) commitHookState(fiber);

  if ((fiber.flags & Placement) !== NoFlags) commitPlacement(fiber);
  if ((fiber.flags & Update) !== NoFlags) commitUpdate(fiber);

  if ((fiber.flags & LayoutEffect) !== NoFlags) {
    collectEffects(fiber, LayoutEffectTag, lists.layoutDestroys, lists.layoutCreates);
  }
  if ((fiber.flags & PassiveEffect) !== NoFlags) {
    collectEffects(fiber, PassiveEffectTag, lists.passiveDestroys, lists.passiveCreates);
  }
}

/** Drop the actions this render consumed; a later render only sees the rest. */
function commitHookState(fiber: Fiber): void {
  let hook = fiber.memoizedState as Hook | null;
  while (hook !== null) {
    const queue = hook.queue;
    if (queue !== null && hook.processed > 0) {
      queue.pending = queue.pending.slice(hook.processed);
      hook.baseState = hook.memoizedState;
      hook.processed = 0;
    }
    hook = hook.next;
  }
}

function collectEffects(
  fiber: Fiber,
  tag: typeof LayoutEffectTag | typeof PassiveEffectTag,
  destroys: Hook[],
  creates: Hook[],
): void {
  let hook = fiber.memoizedState as Hook | null;
  while (hook !== null) {
    if (hook.effectTag === tag && hook.create !== null && !areDepsEqual(hook.deps, hook.nextDeps)) {
      if (hook.destroy !== null) destroys.push(hook);
      creates.push(hook);
    }
    hook = hook.next;
  }
}

function runDestroy(hook: Hook): void {
  const destroy = hook.destroy;
  hook.destroy = null;
  hook.deps = undefined;
  if (destroy !== null) destroy();
}

function runCreate(hook: Hook): void {
  const create = hook.create;
  if (create === null) return;
  hook.deps = hook.nextDeps === undefined ? undefined : hook.nextDeps.slice();
  const destroy = create();
  hook.create = null;
  hook.destroy = typeof destroy === "function" ? destroy : null;
}

/** Publish the boundaries of the new tree, and subscribe the ones still waiting. */
function commitBoundaries(fiber: Fiber): void {
  if (fiber.tag === SuspenseComponent && fiber.boundaryRecord !== undefined) {
    const record = fiber.boundaryRecord;
    record.mounted = true;
    if (fiber.memoizedState === null) {
      record.wait = null;
      record.stash = null;
    } else if (record.wait !== null) {
      subscribe(record, record.wait);
    }
  }
  let child = fiber.child;
  while (child !== null) {
    commitBoundaries(child);
    child = child.sibling;
  }
}

function clearFlags(fiber: Fiber): void {
  fiber.flags = NoFlags;
  fiber.subtreeFlags = NoFlags;
  fiber.deletions = null;
  let child = fiber.child;
  while (child !== null) {
    clearFlags(child);
    child = child.sibling;
  }
}

/** Lanes are only meaningful until the render that consumed them commits. */
function clearLanes(fiber: Fiber, lanes: Lanes): void {
  fiber.lanes &= ~lanes;
  fiber.childLanes &= ~lanes;
  let child = fiber.child;
  while (child !== null) {
    clearLanes(child, lanes);
    child = child.sibling;
  }
}

function commitRoot(root: FiberRoot, finishedWork: Fiber): void {
  const lists: CommitLists = {
    layoutDestroys: [],
    layoutCreates: [],
    passiveDestroys: [],
    passiveCreates: [],
  };

  commitMutationEffects(finishedWork, lists);

  root.current = finishedWork;
  commitBoundaries(finishedWork);

  // Every cleanup of the phase runs before any create, so no effect observes a
  // half-updated tree.
  for (const hook of lists.layoutDestroys) runDestroy(hook);
  for (const hook of lists.layoutCreates) runCreate(hook);

  clearFlags(finishedWork);

  if (lists.passiveDestroys.length > 0 || lists.passiveCreates.length > 0) {
    schedulePassive(root, {
      destroys: lists.passiveDestroys,
      creates: lists.passiveCreates,
    });
  }
}

function schedulePassive(root: FiberRoot, work: PassiveWork): void {
  root.passive = work;
  root.passiveTimer = setTimeout(() => {
    root.passiveTimer = null;
    runPassive(root);
  }, 0);
}

function runPassive(root: FiberRoot): void {
  const work = root.passive;
  if (work === null) return;
  root.passive = null;
  for (const hook of work.destroys) runDestroy(hook);
  for (const hook of work.creates) runCreate(hook);
  if (root.pendingLanes !== NoLanes && !root.isFlushing) flushRoot(root);
}

/** A passive phase is a commit of its own: a render lets it finish first. */
function flushPassiveEffects(root: FiberRoot): void {
  if (root.passive === null) return;
  if (root.passiveTimer !== null) {
    clearTimeout(root.passiveTimer);
    root.passiveTimer = null;
  }
  runPassive(root);
}

// ---- The root --------------------------------------------------------------

function renderRoot(root: FiberRoot, lanes: Lanes): Fiber {
  const previousLanes = renderLanes;
  const previousFiber = currentlyRenderingFiber;
  const previousHook = workInProgressHook;
  const previousCurrentHook = currentHook;

  renderLanes = lanes;
  try {
    const workInProgressRoot = createWorkInProgress(root.current, null);
    let unitOfWork: Fiber | null = workInProgressRoot;
    while (unitOfWork !== null) {
      const currentUnit: Fiber = unitOfWork;
      try {
        unitOfWork = performUnitOfWork(currentUnit);
      } catch (thrown) {
        unitOfWork = handleThrowable(thrown, currentUnit);
      }
    }
    return workInProgressRoot;
  } finally {
    renderLanes = previousLanes;
    currentlyRenderingFiber = previousFiber;
    workInProgressHook = previousHook;
    currentHook = previousCurrentHook;
  }
}

function flushRoot(root: FiberRoot): void {
  if (root.isFlushing) {
    root.needsFlush = true;
    return;
  }
  root.isFlushing = true;
  try {
    do {
      root.needsFlush = false;
      // The passive phase of the previous commit belongs before this render.
      flushPassiveEffects(root);
      if (root.pendingLanes === NoLanes) break;

      const lanes = root.pendingLanes;
      root.pendingLanes = NoLanes;

      const finishedWork = renderRoot(root, lanes);
      clearLanes(finishedWork, lanes);
      commitRoot(root, finishedWork);
    } while (root.needsFlush || root.pendingLanes !== NoLanes);
  } finally {
    root.isFlushing = false;
  }
}

function scheduleFlush(root: FiberRoot): void {
  if (root.isFlushing) {
    root.needsFlush = true;
    return;
  }
  flushRoot(root);
}

// ---- Public API ------------------------------------------------------------

/** Create the root object `createFiberDomRoot` drives. */
export function createFiberRoot(container: Element): FiberRoot {
  const document = container.ownerDocument;
  if (document === null) {
    throw new Error("createRoot() requires a container that belongs to a document.");
  }

  const root: FiberRoot = {
    container,
    document,
    current: createFiber(HostRoot, null, null, null),
    pendingLanes: NoLanes,
    isFlushing: false,
    needsFlush: false,
    mounted: true,
    passive: null,
    passiveTimer: null,
  };
  root.current.stateNode = root;
  root.current.updateQueue = { pending: [] } as RootQueue;
  return root;
}

/** Mount or update the tree the root holds. */
export function renderIntoFiberRoot(root: FiberRoot, element: Any): void {
  if (!root.mounted) return;
  (root.current.updateQueue as RootQueue).pending.push(element);
  root.current.lanes |= SyncLane;
  root.pendingLanes |= SyncLane;
  scheduleFlush(root);
}

/** Drop the tree: cleanups run, the container is emptied, later updates are ignored. */
export function unmountFiberRoot(root: FiberRoot): void {
  if (!root.mounted) return;
  renderIntoFiberRoot(root, null);
  root.mounted = false;
  if (root.passiveTimer !== null) {
    clearTimeout(root.passiveTimer);
    root.passiveTimer = null;
  }
  root.passive = null;

  let child = root.container.firstChild;
  while (child !== null) {
    const next = child.nextSibling;
    root.container.removeChild(child);
    child = next;
  }
}
