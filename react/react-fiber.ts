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
 * Separating the phases is only useful because of one rule, and the rule is
 * about effects, not about functions:
 *
 * - Render never mutates state that can be observed. It may allocate new
 *   objects and write into them (a node that is not attached to anything is
 *   invisible, so building it changes nothing anyone can see), but what is
 *   already visible stays untouched. A description can be discarded; a side
 *   effect cannot. That is why a render can be thrown away and simply run
 *   again — a suspended subtree, a retried boundary, a preempted pass — with
 *   no rollback code anywhere.
 *
 * - Everything the commit needs is decided during render and carried on the
 *   fiber: a flag says *which* work is due, and a fiber field holds the data
 *   for it. Commit then executes that plan once, in a fixed order, and never
 *   re-derives it. The plan and its execution cannot disagree, and what the
 *   host already holds cannot leak back into render.
 *
 * Any reconciler is shaped by the same split: render is a function from "old
 * state + new input" to a description of the change, and commit is an executor
 * that performs that description exactly once.
 *
 * A lane says how urgent an update is. Transition work renders in slices:
 * the walk stops between units when the slice's budget runs out, keeps the
 * fiber it stopped on, and resumes in a later task.
 *
 */

import {
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_SUSPENSE_TYPE,
  ReactSharedInternals,
  isLazyWrapper,
  type Dispatcher,
  type LazyWrapper,
  type TransitionScope,
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
const HookState = 1 << 6;
const HasBoundary = 1 << 7;

const MutationMask =
  ContentReset | Deletion | Placement | Update | LayoutEffect | PassiveEffect | HookState;
const AllFlags = MutationMask | HasBoundary;

/**
 * Lanes: every update names the priority it belongs to, and a fiber carries the
 * union of the lanes that touched it. `lanes` marks the work a fiber itself
 * owes; `childLanes` marks work somewhere below it, which is what lets an
 * ancestor skip its own render while still descending to the child that
 * changed.
 *
 * - `SyncLane` is work the screen has to show now: a click, an input, a root
 *   render, a boundary whose data arrived.
 * - The transition lanes are work that may wait: everything dispatched inside
 *   `startTransition`. Every transition claims its own bit, so one of them can
 *   suspend, finish or be abandoned without touching the others. They render in
 *   slices and yield to the host, and a higher-priority update abandons an
 *   unfinished slice and renders first.
 */
const NoLanes = 0;
const SyncLane = 1 << 0;

/** How many transitions can be in flight before their lanes are reused. */
const TRANSITION_LANE_COUNT = 4;
const FIRST_TRANSITION_LANE = 1 << 1;
const TransitionLanes =
  FIRST_TRANSITION_LANE |
  (FIRST_TRANSITION_LANE << 1) |
  (FIRST_TRANSITION_LANE << 2) |
  (FIRST_TRANSITION_LANE << 3);

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
  /** The union of every flag in the subtree, so a commit can skip clean subtrees. */
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
  /**
   * Lanes whose work cannot make progress yet (a boundary is waiting on a
   * thenable). They stay pending, but the scheduler will not pick them up until
   * the thenable settles.
   */
  suspendedLanes: Lanes;
  /** The pending callback for concurrent work, so urgent work can cancel it. */
  callbackTimer: Any;
  /** A concurrent slice is running; work dispatched now waits for it to yield. */
  isRendering: boolean;
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
  /** The lane the dispatch happened on; an urgent render only runs its own. */
  lane: Lanes;
}

interface HookQueue {
  /** Actions dispatched since the last commit, in dispatch order. */
  pending: StateUpdate[];
  dispatch: ((action: Any) => void) | null;
  fiber: Fiber;
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

function requireRenderingFiber(): Fiber {
  const fiber = currentlyRenderingFiber;
  if (fiber === null) {
    throw new Error("Invalid hook call. Hooks can only be called inside a component's body.");
  }
  return fiber;
}

function updateWorkInProgressHook(): Hook {
  const fiber = requireRenderingFiber();

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
  const lane = requestUpdateLane();
  queue.pending.push({ action, lane });
  const fiber = queue.fiber;
  const root = getRootOfFiber(fiber);
  if (root === null || !root.mounted) return;
  markUpdateLane(fiber, lane);
  ensureRootIsScheduled(root);
}

/** The lane of the transition whose scope is on the stack, or `NoLanes`. */
let currentTransitionLane: Lanes = NoLanes;
/** Round-robin cursor, so a new transition does not reuse a live lane at once. */
let nextTransitionLane = 0;

/** Transitions whose async scope is still running; their lane stays open. */
const openAsyncTransitions = new Set<Lanes>();

/** Take a lane for a new transition; a nested scope joins the one it is in. */
function claimTransitionLane(): Lanes {
  if (currentTransitionLane !== NoLanes) return currentTransitionLane;
  const lane = FIRST_TRANSITION_LANE << nextTransitionLane;
  nextTransitionLane = (nextTransitionLane + 1) % TRANSITION_LANE_COUNT;
  return lane;
}

/**
 * Run a transition scope on `lane`. An async scope keeps the lane open until it
 * settles: an update after an `await` still belongs to this transition, and
 * `isPending` stays true while the promise runs.
 */
function runTransitionScope(
  scope: () => void | PromiseLike<Any>,
  lane: Lanes,
  onSettled?: () => void,
): void {
  const previous = currentTransitionLane;
  currentTransitionLane = lane;

  let result: void | PromiseLike<Any>;
  try {
    result = scope();
  } catch (error) {
    currentTransitionLane = previous;
    throw error;
  }

  if (isThenable(result)) {
    openAsyncTransitions.add(lane);
    Promise.resolve(result).finally(() => {
      openAsyncTransitions.delete(lane);
      // Another transition may have taken over while this one was waiting.
      if (currentTransitionLane === lane) currentTransitionLane = previous;
      onSettled?.();
    });
    return;
  }

  currentTransitionLane = previous;
  onSettled?.();
}

/** The lane an update dispatched right now belongs to. */
function requestUpdateLane(): Lanes {
  return currentTransitionLane !== NoLanes ? currentTransitionLane : SyncLane;
}

/** Dispatch at `SyncLane` even inside a transition; `isPending` is urgent. */
function dispatchUrgently(dispatch: (pending: boolean) => void, pending: boolean): void {
  const lane = currentTransitionLane;
  currentTransitionLane = NoLanes;
  try {
    dispatch(pending);
  } finally {
    currentTransitionLane = lane;
  }
}

/** A `useTransition` waiting for its own transition to finish. */
interface PendingTransition {
  /** The component that asked, so unmounting it can drop the entry. */
  fiber: Fiber;
  root: FiberRoot | null;
  /** The lane its scope ran on; the entry is done when the lane is. */
  lane: Lanes;
  set: (pending: boolean) => void;
}

const pendingTransitions = new Set<PendingTransition>();

// The renderer owns what a transition means, so `startTransition` in `react.ts`
// delegates here. Targets that render synchronously never set it.
ReactSharedInternals.startTransition = (scope: TransitionScope) => {
  const lane = claimTransitionLane();
  runTransitionScope(scope, lane);
};

/** Clear `isPending` for every transition of `root` that has nothing left. */
function finishTransitionWork(root: FiberRoot): void {
  if (pendingTransitions.size === 0) return;

  const finished: PendingTransition[] = [];
  for (const entry of pendingTransitions) {
    if (entry.root !== root) continue;
    // Still waiting on an async scope, or on a lane with work left.
    if (openAsyncTransitions.has(entry.lane)) continue;
    if (((root.pendingLanes | root.suspendedLanes) & entry.lane) !== NoLanes) continue;
    finished.push(entry);
  }
  for (const entry of finished) {
    pendingTransitions.delete(entry);
    dispatchUrgently(entry.set, false);
  }
}

function mountState<S>(hook: Hook, initialState: S | (() => S)): [S, (action: Any) => void] {
  const state = typeof initialState === "function" ? (initialState as () => S)() : initialState;
  hook.memoizedState = state;
  hook.baseState = state;
  const queue: HookQueue = { pending: [], dispatch: null, fiber: requireRenderingFiber() };
  queue.dispatch = (action: Any) => dispatchAction(queue, action);
  hook.queue = queue;
  return [state, queue.dispatch];
}

function updateState<S>(hook: Hook): [S, (action: Any) => void] {
  const queue = hook.queue as HookQueue;
  const fiber = requireRenderingFiber();
  queue.fiber = fiber;

  // A transition action belongs to a later render: the urgent render that runs
  // first must not apply it, or it would commit what the transition deferred.
  let state = hook.baseState as S;
  let processed = 0;
  while (processed < queue.pending.length) {
    const update = queue.pending[processed];
    // A lane this render does not cover has to wait, so an urgent pass never
    // commits what a transition deferred (and vice versa).
    if ((update.lane & renderLanes) === NoLanes) break;
    state =
      typeof update.action === "function"
        ? (update.action as (previous: S) => S)(state)
        : (update.action as S);
    processed++;
  }

  if (processed > 0) {
    hook.memoizedState = state;
    fiber.flags |= HookState;
  }
  hook.processed = processed;
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
    fiber: requireRenderingFiber(),
    reducer,
  };
  queue.dispatch = (action: Any) => dispatchAction(queue, action);
  hook.queue = queue;
  return [state, queue.dispatch as (action: A) => void];
}

function updateReducer<S, A>(hook: Hook): [S, (action: A) => void] {
  const queue = hook.queue as HookQueue;
  const fiber = requireRenderingFiber();
  queue.fiber = fiber;

  const reducer = (queue as Any).reducer as (state: S, action: A) => S;
  let state = hook.baseState as S;
  let processed = 0;
  while (processed < queue.pending.length) {
    const update = queue.pending[processed];
    if ((update.lane & renderLanes) === NoLanes) break;
    state = reducer(state, update.action as A);
    processed++;
  }

  if (processed > 0) {
    hook.memoizedState = state;
    fiber.flags |= HookState;
  }
  hook.processed = processed;
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
  const fiber = requireRenderingFiber();
  const hook = updateWorkInProgressHook();

  hook.effectTag = tag;
  hook.create = create;
  hook.nextDeps = deps;

  if (hook.isNew || !areDepsEqual(hook.deps, deps)) {
    fiber.flags |= tag === LayoutEffectTag ? LayoutEffect : PassiveEffect;
  }
}

/**
 * `useTransition` stores its `isPending` flag in a state hook and keeps the
 * setter of that hook in a module set, so the scheduler can clear it when the
 * last transition lane commits.
 */
function readTransition(): [boolean, (scope: () => void | PromiseLike<Any>) => void] {
  const fiber = requireRenderingFiber();
  const [isPending, setIsPending] = readState<boolean>(false);
  const start = readMemo<(scope: () => void | PromiseLike<Any>) => void>(
    () => (scope) => {
      const set = setIsPending as (pending: boolean) => void;
      const root = getRootOfFiber(fiber);
      const lane = claimTransitionLane();

      // The indicator is urgent, and it is not part of the transition's work.
      dispatchUrgently(set, true);
      if (root !== null) pendingTransitions.add({ fiber, root, lane, set });

      try {
        runTransitionScope(scope, lane, () => {
          if (root !== null) finishTransitionWork(root);
        });
      } catch (error) {
        // The scope failed before it could finish: nothing is owed, so the
        // flag must not stick.
        if (root !== null) finishTransitionWork(root);
        throw error;
      }
    },
    [],
  );
  return [isPending, start];
}

const hookDispatcher: Dispatcher = {
  useState: readState,
  useReducer: readReducer,
  useRef: readRef,
  useMemo: readMemo,
  useEffect: (create, deps) => readEffect(create, deps, PassiveEffectTag),
  useLayoutEffect: (create, deps) => readEffect(create, deps, LayoutEffectTag),
  useTransition: readTransition,
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
  /** The lane the waiting attempt rendered at, so its retry runs there too. */
  waitLane: Lanes;
  /** The last committed content, kept alive while the fallback is on screen. */
  stash: Fiber | null;
}

function createBoundaryRecord(): BoundaryRecord {
  return { fiber: null, mounted: false, wait: null, waitLane: NoLanes, stash: null };
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

  // One settlement, one retry: a new attempt that suspends again stores a new
  // wait, and that one is what the next settlement has to wake.
  const lane = record.waitLane;
  record.wait = null;

  markUpdateLane(fiber, lane);
  ensureRootIsScheduled(root);
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

// ---- The scheduler ---------------------------------------------------------
//
// A concurrent render is resumable: the walk keeps the unit it stopped on, so
// the next task continues from there instead of starting over. The deadline is
// refreshed per task, and `shouldYield` is checked between units.

/** How long one concurrent slice may run before it hands the host back. */
const DEFAULT_FRAME_BUDGET_MS = 5;
let frameBudgetMs = DEFAULT_FRAME_BUDGET_MS;
let frameDeadline = 0;

/** Tune the length of a slice; tests set it to `0` to force a yield after each unit. */
export function setFrameBudgetMs(ms: number): void {
  frameBudgetMs = ms;
}

function now(): number {
  return typeof performance === "object" && performance !== null ? performance.now() : Date.now();
}

function shouldYield(): boolean {
  return now() >= frameDeadline;
}

/** The tree the current concurrent render is building, kept across slices. */
let workInProgressRoot: FiberRoot | null = null;
let workInProgressRootFiber: Fiber | null = null;
let workInProgressUnit: Fiber | null = null;
let workInProgressLanes: Lanes = NoLanes;
/** Set when a transition suspended with content on screen: nothing to commit. */
let renderWasSuspended = false;

function prepareFreshStack(root: FiberRoot, lanes: Lanes): void {
  workInProgressRoot = root;
  workInProgressRootFiber = createWorkInProgress(root.current, null);
  workInProgressUnit = workInProgressRootFiber;
  workInProgressLanes = lanes;
  renderWasSuspended = false;
}

function resetWorkInProgressStack(): void {
  workInProgressRoot = null;
  workInProgressRootFiber = null;
  workInProgressUnit = null;
  workInProgressLanes = NoLanes;
  renderWasSuspended = false;
}

/** The highest-priority work the root can do now; suspended lanes are skipped. */
function getNextLanes(root: FiberRoot): Lanes {
  const pending = root.pendingLanes & ~root.suspendedLanes;
  if (pending === NoLanes) return NoLanes;
  if ((pending & SyncLane) !== NoLanes) return SyncLane;
  // Every transition that is not waiting on data renders together.
  return pending & TransitionLanes;
}

function getRootOfFiber(fiber: Fiber | null): FiberRoot | null {
  let node = fiber;
  while (node !== null) {
    if (node.tag === HostRoot) return node.stateNode as FiberRoot;
    node = node.return;
  }
  return null;
}

function markUpdateLane(fiber: Fiber, lane: Lanes): void {
  // Dispatch closures keep the fiber the hook was mounted on, which may now be
  // the alternate: both sides of every pair have to carry the lane.
  fiber.lanes |= lane;
  if (fiber.alternate !== null) fiber.alternate.lanes |= lane;

  let node = fiber.return;
  while (node !== null) {
    node.childLanes |= lane;
    if (node.alternate !== null) node.alternate.childLanes |= lane;
    node = node.return;
  }
  const root = getRootOfFiber(fiber);
  if (root !== null) {
    root.pendingLanes |= lane;
    // New work on a lane is also a reason to try it again.
    root.suspendedLanes &= ~lane;
  }
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
  const hasOwnLane = (workInProgress.lanes & renderLanes) !== NoLanes;

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
  if ((workInProgress.childLanes & renderLanes) === NoLanes) return null;
  cloneChildFibers(workInProgress);
  return workInProgress.child;
}

function updateHostComponent(workInProgress: Fiber): Fiber | null {
  workInProgress.lanes &= ~renderLanes;
  const props: Any = workInProgress.pendingProps ?? {};
  const current = workInProgress.alternate;

  if (props.dangerouslySetInnerHTML !== null && props.dangerouslySetInnerHTML !== undefined) {
    // The HTML owns the children, so none are created. The old ones still have
    // to go through reconciliation: the HTML write removes their nodes, but only
    // a deletion runs their cleanups and unsubscribes the boundaries inside.
    reconcileChildren(workInProgress, current?.child ?? null, []);
    return null;
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
  // Prefer the committed fiber: this pass may be thrown away, and a retry has
  // to schedule from the tree that is on screen.
  record.fiber = current ?? workInProgress;

  const props: Any = workInProgress.pendingProps ?? {};
  const retry = (workInProgress.lanes & renderLanes) !== NoLanes;
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
    if (currentSuspended) {
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
        // The node is on screen: plan the change, do not perform it. Both sides
        // of the comparison come from the fiber tree, so the plan is settled
        // before the commit runs and cannot depend on what the DOM holds.
        const previous = normalizeProperties(current.memoizedProps ?? {});
        const next = normalizeProperties(workInProgress.pendingProps ?? {});
        const payload = diffProperties(previous, next);
        if (previous.innerHTML !== null && next.innerHTML === null) {
          // Children replace markup the document owns. The element has to be
          // empty before they are placed, which is earlier than `Update` runs,
          // so the clear is scheduled as its own, earlier mutation.
          workInProgress.flags |= ContentReset;
        }
        workInProgress.updateQueue = payload;
        if (payload !== null) workInProgress.flags |= Update;
      } else {
        // No node yet, so building it is not a mutation: it is detached, and it
        // only becomes visible when the commit places it.
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
    case SuspenseComponent: {
      workInProgress.flags |= HasBoundary;
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

  // A transition that suspends keeps the screen it already has: the attempt is
  // dropped whole and the boundary waits for the data without a fallback.
  if ((renderLanes & TransitionLanes) !== NoLanes && current !== null && !currentSuspended) {
    record.wait = thrown;
    record.waitLane = renderLanes;

    const root = getRootOfFiber(boundary);
    // Only the transitions this render covered are suspended: another one keeps
    // rendering (and committing) while this waits for its data.
    if (root !== null) root.suspendedLanes |= renderLanes;
    // No commit will run for this attempt, so nothing else would subscribe.
    subscribe(record, thrown);

    renderWasSuspended = true;
    return null;
  }

  // The content on screen is the only thing that can be reused by a retry, so
  // it is detached from the tree instead of being unmounted.
  if (!currentSuspended && current !== null && current.child !== null) {
    record.stash = current.child;
    retainSubtree(current.child);
  }

  record.wait = thrown;
  record.waitLane = renderLanes;

  boundary.memoizedState = { suspended: true, thenable: thrown };
  boundary.captured = true;
  boundary.child = null;
  boundary.deletions = null;
  boundary.flags &= ~Deletion;
  return boundary;
}

// ---- Host mutation ---------------------------------------------------------

function setInitialProperties(instance: Any, properties: NormalizedProperties): void {
  for (const [name, value] of properties.attributes) instance.setAttribute(name, value);
  for (const [type, listener] of properties.events) instance.addEventListener(type, listener);
  if (properties.innerHTML !== null) instance.innerHTML = properties.innerHTML;
}

interface PropertyUpdate {
  set: Array<[string, string]>;
  remove: string[];
  attach: Array<[string, Any]>;
  detach: Array<[string, Any]>;
  html: string | undefined;
}

function isNoopUpdate(update: PropertyUpdate): boolean {
  return (
    update.set.length === 0 &&
    update.remove.length === 0 &&
    update.attach.length === 0 &&
    update.detach.length === 0 &&
    update.html === undefined
  );
}

function diffProperties(
  previous: NormalizedProperties,
  next: NormalizedProperties,
): PropertyUpdate | null {
  const previousAttributes = new Map(previous.attributes);
  const nextAttributes = new Map(next.attributes);
  const previousEvents = new Map(previous.events);
  const nextEvents = new Map(next.events);

  const set: Array<[string, string]> = [];
  for (const [name, value] of nextAttributes) {
    if (previousAttributes.get(name) !== value) set.push([name, value]);
  }
  const remove: string[] = [];
  for (const name of previousAttributes.keys()) {
    if (!nextAttributes.has(name)) remove.push(name);
  }

  const attach: Array<[string, Any]> = [];
  for (const [type, listener] of nextEvents) {
    if (previousEvents.get(type) !== listener) attach.push([type, listener]);
  }
  const detach: Array<[string, Any]> = [];
  for (const [type, listener] of previousEvents) {
    if (nextEvents.get(type) !== listener) detach.push([type, listener]);
  }

  const html = previous.innerHTML === next.innerHTML ? undefined : (next.innerHTML ?? undefined);
  const update: PropertyUpdate = { set, remove, attach, detach, html };
  return isNoopUpdate(update) ? null : update;
}

function applyPropertyUpdate(instance: Any, update: PropertyUpdate): void {
  for (const name of update.remove) instance.removeAttribute(name);
  for (const [name, value] of update.set) instance.setAttribute(name, value);
  for (const [type, listener] of update.detach) instance.removeEventListener(type, listener);
  for (const [type, listener] of update.attach) instance.addEventListener(type, listener);
  if (update.html !== undefined) instance.innerHTML = update.html;
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
  const payload = fiber.updateQueue as PropertyUpdate | null;
  fiber.updateQueue = null;
  if (payload !== null) applyPropertyUpdate(instance, payload);
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

  // A component that leaves the tree can never clear its own pending flag.
  for (const entry of [...pendingTransitions]) {
    if (entry.fiber === fiber || entry.fiber.alternate === fiber) {
      pendingTransitions.delete(entry);
    }
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
  if (((fiber.flags | fiber.subtreeFlags) & MutationMask) === NoFlags) return;

  // Switch back from HTML before any child is placed into the element.
  if ((fiber.flags & ContentReset) !== NoFlags && fiber.tag === HostComponent) {
    fiber.stateNode.innerHTML = "";
  }

  // Old nodes leave before the new ones are placed, so siblings resolve.
  if ((fiber.flags & Deletion) !== NoFlags && fiber.deletions !== null) {
    for (const deleted of fiber.deletions) commitDeletion(deleted);
    fiber.deletions = null;
  }

  let child = fiber.child;
  while (child !== null) {
    commitMutationEffects(child, lists);
    child = child.sibling;
  }

  if (fiber.tag === FunctionComponent && (fiber.flags & HookState) !== NoFlags) {
    commitHookState(fiber);
  }

  if ((fiber.flags & Placement) !== NoFlags) commitPlacement(fiber);
  if ((fiber.flags & Update) !== NoFlags) commitUpdate(fiber);

  if ((fiber.flags & LayoutEffect) !== NoFlags) {
    collectEffects(fiber, LayoutEffectTag, lists.layoutDestroys, lists.layoutCreates);
  }
  if ((fiber.flags & PassiveEffect) !== NoFlags) {
    collectEffects(fiber, PassiveEffectTag, lists.passiveDestroys, lists.passiveCreates);
  }
}

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

function commitBoundaries(fiber: Fiber, lanes: Lanes): void {
  if (((fiber.flags | fiber.subtreeFlags) & HasBoundary) === NoFlags) return;

  if (fiber.tag === SuspenseComponent && fiber.boundaryRecord !== undefined) {
    const record = fiber.boundaryRecord;
    record.fiber = fiber;
    record.mounted = true;
    if (fiber.memoizedState === null) {
      // Content committed. Only the lane that armed the wait can retire it:
      // another lane's commit may have re-rendered the same boundary while it
      // was still waiting on a different transition.
      if ((record.waitLane & lanes) !== NoLanes) {
        record.wait = null;
        record.waitLane = NoLanes;
        record.stash = null;
      }
    } else if (record.wait !== null) {
      subscribe(record, record.wait);
    }
  }
  let child = fiber.child;
  while (child !== null) {
    commitBoundaries(child, lanes);
    child = child.sibling;
  }
}

function clearFlags(fiber: Fiber): void {
  if (((fiber.flags | fiber.subtreeFlags) & AllFlags) === NoFlags) return;
  fiber.flags = NoFlags;
  fiber.subtreeFlags = NoFlags;
  fiber.deletions = null;
  let child = fiber.child;
  while (child !== null) {
    clearFlags(child);
    child = child.sibling;
  }
}

function clearLanes(fiber: Fiber, lanes: Lanes): void {
  if ((fiber.lanes | fiber.childLanes) === NoLanes) return;
  fiber.lanes &= ~lanes;
  fiber.childLanes &= ~lanes;
  let child = fiber.child;
  while (child !== null) {
    clearLanes(child, lanes);
    child = child.sibling;
  }
}

function commitRoot(root: FiberRoot, finishedWork: Fiber, lanes: Lanes): void {
  const lists: CommitLists = {
    layoutDestroys: [],
    layoutCreates: [],
    passiveDestroys: [],
    passiveCreates: [],
  };

  commitMutationEffects(finishedWork, lists);

  root.current = finishedWork;
  commitBoundaries(finishedWork, lanes);

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
  if (root.pendingLanes !== NoLanes && !root.isFlushing) ensureRootIsScheduled(root);
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

function renderRootSync(root: FiberRoot, lanes: Lanes): Fiber {
  // Urgent work never resumes a lower-priority tree: that render is dropped.
  resetWorkInProgressStack();
  prepareFreshStack(root, lanes);

  const previousLanes = renderLanes;
  renderLanes = lanes;
  try {
    while (workInProgressUnit !== null) {
      const unit: Fiber = workInProgressUnit;
      try {
        workInProgressUnit = performUnitOfWork(unit);
      } catch (thrown) {
        workInProgressUnit = handleThrowable(thrown, unit);
      }
    }
    return workInProgressRootFiber as Fiber;
  } finally {
    renderLanes = previousLanes;
  }
}

/**
 * Render until the slice's budget runs out. Returning `null` means the tree is
 * not finished: either the slice yielded (the work in progress is kept for the
 * next task) or a transition suspended and the screen was left alone.
 */
function renderRootConcurrent(root: FiberRoot, lanes: Lanes): Fiber | null {
  if (workInProgressRoot !== root || workInProgressLanes !== lanes || workInProgressUnit === null) {
    prepareFreshStack(root, lanes);
  }

  const previousLanes = renderLanes;
  renderLanes = lanes;
  try {
    while (workInProgressUnit !== null) {
      const unit: Fiber = workInProgressUnit;
      try {
        workInProgressUnit = performUnitOfWork(unit);
      } catch (thrown) {
        workInProgressUnit = handleThrowable(thrown, unit);
      }
      if (renderWasSuspended) return null;
      if (workInProgressUnit !== null && shouldYield()) return null;
    }
    return workInProgressRootFiber;
  } finally {
    renderLanes = previousLanes;
  }
}

/** Render every sync lane to completion, now. */
function flushSyncWork(root: FiberRoot): void {
  if (root.isFlushing) {
    root.needsFlush = true;
    return;
  }
  root.isFlushing = true;
  cancelConcurrentCallback(root);
  pendingSyncRoots.delete(root);
  try {
    do {
      root.needsFlush = false;
      // The passive phase of the previous commit belongs before this render.
      flushPassiveEffects(root);
      if ((root.pendingLanes & SyncLane) === NoLanes) break;

      root.pendingLanes &= ~SyncLane;
      const finishedWork = renderRootSync(root, SyncLane);
      clearLanes(finishedWork, SyncLane);
      commitRoot(root, finishedWork, SyncLane);
      resetWorkInProgressStack();
      finishTransitionWork(root);
    } while (root.needsFlush || (root.pendingLanes & SyncLane) !== NoLanes);
  } finally {
    root.isFlushing = false;
  }

  if (getNextLanes(root) !== NoLanes) ensureRootIsScheduled(root);
}

function cancelConcurrentCallback(root: FiberRoot): void {
  if (root.callbackTimer === null) return;
  clearTimeout(root.callbackTimer);
  root.callbackTimer = null;
}

function scheduleConcurrentWork(root: FiberRoot): void {
  if (root.callbackTimer !== null || root.isFlushing) return;
  root.callbackTimer = setTimeout(() => {
    root.callbackTimer = null;
    performConcurrentWorkOnRoot(root);
  }, 0);
}

// ---- Batching --------------------------------------------------------------
//
// A dispatch never renders on the spot. Sync work is queued and flushed in a
// microtask, once the task that queued it has run to completion, so every
// update one event (or one promise callback) dispatches lands in a single
// render. It is also why an urgent update is not observable while the handler
// that made it is still on the stack.

const pendingSyncRoots = new Set<FiberRoot>();
let syncFlushQueued = false;

function queueSyncWork(root: FiberRoot): void {
  pendingSyncRoots.add(root);
  if (syncFlushQueued) return;
  syncFlushQueued = true;
  queueMicrotask(() => {
    syncFlushQueued = false;
    flushPendingSyncWork();
  });
}

/** Commit every root whose sync work is queued, now. */
function flushPendingSyncWork(): void {
  if (pendingSyncRoots.size === 0) return;
  const roots = [...pendingSyncRoots];
  pendingSyncRoots.clear();
  for (const root of roots) {
    if (root.mounted) flushSyncWork(root);
  }
}

/**
 * Run `scope` and commit the sync work it queued before returning, the way
 * React's `flushSync` opts out of the batch. Tests use it as their `act`.
 */
export function flushSync<T>(scope: () => T): T {
  try {
    return scope();
  } finally {
    flushPendingSyncWork();
  }
}

/** One slice of a concurrent render: render, and commit only if it finished. */
function performConcurrentWorkOnRoot(root: FiberRoot): void {
  if (!root.mounted || root.isFlushing) return;

  const lanes = getNextLanes(root);
  if (lanes === NoLanes) return;
  if ((lanes & SyncLane) !== NoLanes) {
    flushSyncWork(root);
    return;
  }

  // A passive phase is a commit of its own: finish it before rendering again.
  flushPassiveEffects(root);

  root.isRendering = true;
  frameDeadline = now() + frameBudgetMs;
  let finishedWork: Fiber | null;
  try {
    finishedWork = renderRootConcurrent(root, lanes);
  } finally {
    root.isRendering = false;
  }

  if (finishedWork === null) {
    if (renderWasSuspended) {
      // Waiting on a thenable: the ping schedules the retry.
      resetWorkInProgressStack();
    } else {
      // Yielded: continue in a fresh task, from the fiber it stopped on.
      scheduleConcurrentWork(root);
    }
    if (root.needsFlush) {
      root.needsFlush = false;
      ensureRootIsScheduled(root);
    }
    return;
  }

  root.pendingLanes &= ~lanes;
  clearLanes(finishedWork, lanes);
  // Publishing the tree is atomic: an effect that dispatches here queues its
  // work behind this commit instead of rendering inside it.
  root.isFlushing = true;
  try {
    commitRoot(root, finishedWork, lanes);
  } finally {
    root.isFlushing = false;
  }
  resetWorkInProgressStack();
  finishTransitionWork(root);

  root.needsFlush = false;
  ensureRootIsScheduled(root);
}

/** Pick the lane to work on and either run it now or hand it to a task. */
function ensureRootIsScheduled(root: FiberRoot): void {
  if (!root.mounted) return;
  if (root.isRendering) {
    // A slice is running; it decides what to do once it stops.
    root.needsFlush = true;
    return;
  }

  const lanes = getNextLanes(root);
  if (lanes === NoLanes) {
    cancelConcurrentCallback(root);
    return;
  }
  if ((lanes & SyncLane) !== NoLanes) {
    // Urgent work is still batched: it commits when the current task ends.
    queueSyncWork(root);
    return;
  }
  scheduleConcurrentWork(root);
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
    suspendedLanes: NoLanes,
    callbackTimer: null,
    isRendering: false,
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
  // An explicit render is the caller asking for this tree now, so it opts out
  // of the batch that state updates go through.
  flushSyncWork(root);
}

/** Drop the tree: cleanups run, the container is emptied, later updates are ignored. */
export function unmountFiberRoot(root: FiberRoot): void {
  if (!root.mounted) return;
  renderIntoFiberRoot(root, null);
  root.mounted = false;
  cancelConcurrentCallback(root);
  if (workInProgressRoot === root) resetWorkInProgressStack();
  root.pendingLanes = NoLanes;
  root.suspendedLanes = NoLanes;
  for (const entry of [...pendingTransitions]) {
    if (entry.root === root) pendingTransitions.delete(entry);
  }
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
