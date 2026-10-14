/**
 * A small implementation of the core of React's RSC serializer.
 */

import { Emitter } from "./emitter.ts";
import {
  SERIALIZED_UNDEFINED,
  encodeRow,
  serializeBigInt,
  serializeByValueID,
  serializeDate,
  serializeLazyID,
  serializeNumber,
  serializePromiseID,
  serializeServerReferenceID,
  serializeString,
  serializeSymbol,
  type RowTag,
} from "./react-flight-protocol.ts";
import {
  REACT_ELEMENT_TYPE,
  clientReferenceMeta,
  createLazyWrapper,
  isClientReference,
  isLazyWrapper,
  isServerReference,
  serverReferenceMeta,
  use,
  type ClientReference,
  type ServerReference,
} from "./react.ts";
import { isThenable, type Any, type Thenable } from "./shared.ts";

// ---- Small helpers ---------------------------------------------------------

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function isPlainObject(v: Any): boolean {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// ---- Request + Task. A "task" is one row we owe the client. ----------------

export type TaskStatus =
  | "pending"
  | "rendering"
  | "resolving"
  | "completed"
  | "errored"
  | "aborted";

export type TaskEvents = {
  [S in TaskStatus]: () => void;
};

export class Task extends Emitter<TaskEvents> {
  /** The row id. */
  readonly id: number;
  /** The request this task belongs to. */
  readonly request: Request;

  /** The row's root model, it may be updated when retrying. */
  model: Any;
  /** Where this task is in its lifecycle. */
  status: TaskStatus = "pending";

  constructor(request: Request, model?: Any) {
    super();
    this.id = request.nextId++;
    this.request = request;
    this.model = model;
  }

  /** Enqueue this task once its model is ready. */
  ping(): void {
    this.request.pingTask(this);
  }

  setStatus(status: TaskStatus): void {
    const previous = this.status;
    if (previous === status) return;
    this.status = status;
    this.emit(status);
  }

  createSubTask(model?: Any): Task {
    return this.request.createTask(model);
  }
}

export type RequestStatus = "open" | "closed";

export type RequestEvents = {
  task: (task: Task) => void;
};

class Request extends Emitter<RequestEvents> {
  /** The model this request serializes: the root row (id 0) is this value. */
  model: Any;
  /** Encodes rows to bytes. */
  encoder: TextEncoder;
  /** The stream controller, once the stream has started. */
  destination: ReadableStreamDefaultController<Uint8Array>;
  /** Where the request is in its lifecycle. */
  status: RequestStatus = "open";
  /** Next row id to hand out. */
  nextId = 0;
  /** Rows allocated but not yet written; the stream closes when this hits 0. */
  pendingChunks = 0;
  /** Tasks with work to do. */
  pingedTasks: Task[] = [];
  /** Encoded rows ready to be written out. */
  completedChunks: Uint8Array[] = [];
  /** value -> its reference string, for deduplication. */
  writtenObjects: WeakMap<object, string> = new WeakMap();
  /** `module#export` -> import row id. */
  writtenClientReferences: Map<string, number> = new Map();
  /** server reference -> metadata row id. */
  writtenServerReferences: Map<ServerReference, number> = new Map();
  /** Tasks that can still be aborted. */
  abortableTasks: Set<Task> = new Set();

  constructor(
    model: Any,
    encoder: TextEncoder,
    destination: ReadableStreamDefaultController<Uint8Array>,
  ) {
    super();
    this.model = model;
    this.encoder = encoder;
    this.destination = destination;
  }

  createTask(model?: Any): Task {
    const task = new Task(this, model);
    this.abortableTasks.add(task);
    this.pendingChunks++;
    this.emit("task", task);
    return task;
  }

  startWork(): void {
    this.pingTask(this.createTask(this.model));
  }

  /** Wake a task up: enqueue it and schedule a flush on a microtask. */
  pingTask(task: Task): void {
    if (this.status === "closed" || task.status !== "pending") return;
    this.pingedTasks.push(task);
    if (this.pingedTasks.length === 1) {
      queueMicrotask(() => {
        const tasks = this.pingedTasks;
        this.pingedTasks = [];
        for (const task of tasks) {
          retryTask(task);
        }
        flushCompletedChunks(this);
      });
    }
  }
}

/**
 * Render one task into a row.
 *
 * Render the root with suspension/error guard: a thenable thrown retries
 * the same task. Then walk the rendered result and a deeper suspension
 * becomes a lazy reference to a new task.
 */
function retryTask(task: Task): void {
  const request = task.request;
  if (request.status === "closed" || task.status !== "pending") return;

  task.setStatus("rendering");
  let rendered: Any;
  // Guard: Server Component rendering may throw a thenable (suspension) or an error.
  try {
    destructiveModels = [];
    rendered = renderModelDestructive(task, null, "", task.model);
  } catch (thrownValue) {
    if (isThenable(thrownValue)) {
      task.model = destructiveModels[destructiveModels.length - 1];
      task.setStatus("pending");
      trackSuspendedModels(destructiveModels, task);
      const ping = () => task.ping();
      thrownValue.then(ping, ping);
      return;
    }
    erroredTask(task, thrownValue);
    return;
  }

  task.setStatus("resolving");
  let json: string;
  // Guard: reading props (by getter) in object/array walking or JSON.stringify may throw an error.
  try {
    json = JSON.stringify(resolveModel(task, rendered));
  } catch (error) {
    erroredTask(task, error);
    return;
  }

  task.setStatus("completed");
  request.abortableTasks.delete(task);
  emitModelChunk(request, task.id, json);
}

function erroredTask(task: Task, error: Any): void {
  const request = task.request;
  if (request.status === "closed" || task.status === "aborted") return;
  task.setStatus("errored");
  request.abortableTasks.delete(task);
  request.pendingChunks++;
  const errorId = request.nextId++;
  emitErrorChunk(request, errorId, error);
  // Point this task's row at the error row.
  emitModelChunk(request, task.id, JSON.stringify(serializeByValueID(errorId)));
}

// ---- The serializer. Three cooperating pieces: -----------------------------
//
//    renderModelDestructive — serialize ONE value. Recurses through Server
//      Component rendering and returns either an encoded leaf or a raw container
//      whose children still need walking.
//
//    renderModel — the rsc rendering guard. It wraps `renderModelDestructive`
//      and catches any thrown thenable or error. A thenable becomes a new task
//      and returns a lazy reference to it.
//
//    resolveModel — the walker. It takes a raw container (including React elements)
//      returned from `renderModel` and walks it.

/**
 * The chain of values in recursive rendering, outermost first. When catching thrown,
 * the last value which was suspended is retried with existing or a new task and
 * each value in this chain is encoded with the same lazy reference.
 */
let destructiveModels: Any[];

function trackSuspendedModels(models: Any[], task: Task): void {
  const setRef = (ref: string) => models.forEach((v) => task.request.writtenObjects.set(v, ref));
  const resetRef = () => models.forEach((v) => task.request.writtenObjects.delete(v));
  const lazyRef = serializeLazyID(task.id);
  const byValueRef = serializeByValueID(task.id);
  setRef(lazyRef);
  task.on("pending", () => setRef(lazyRef));
  task.on("rendering", resetRef);
  task.on("resolving", () => setRef(byValueRef));
}

function renderModelDestructive(task: Task, parent: Any, key: string, value: Any): Any {
  if (value === REACT_ELEMENT_TYPE) return "$";
  if (value === null) return null;

  if (typeof value === "object") {
    // -- Date --------------------------------------------------------------
    if (value instanceof Date) return serializeDate(value);

    const reused = reuseRef(task, parent, key, value);
    // already written: point at it.
    if (reused !== undefined) return reused;

    // -- React element -----------------------------------------------------
    if (value.$$typeof === REACT_ELEMENT_TYPE) {
      let type = value.type;

      // Resolve lazy types all the way down: a lazy may wrap another lazy.
      while (isLazyWrapper(type)) {
        try {
          type = type._init();
        } catch (thrown) {
          if (isThenable(thrown)) {
            destructiveModels.push(value);
          }
          throw thrown;
        }
      }

      // A function type is a Server Component.
      if (typeof type === "function" && !isClientReference(type)) {
        destructiveModels.push(value);
        const rendered = type(value.props);
        // Recursing directly would emit a promise reference (`$@id`) into
        // a child slot, while the client cannot render. Throw the thenable
        // instead to make a lazy reference (`$Lid`).
        if (isThenable(rendered)) {
          destructiveModels.push(createLazyWrapper(() => use(rendered)));
          throw rendered;
        }
        return renderModelDestructive(task, parent, key, rendered);
      }

      // Client / host element: emit the tuple `[type, key, props]`.
      // `type` and `props` stay raw for `resolveModel` to walk.
      const tuple = [REACT_ELEMENT_TYPE, value.type, value.key, value.props];
      // Register the reference to compute child paths.
      registerRef(task, parent, key, tuple);
      return tuple;
    }

    // -- Lazy wrapper around a Server Component's returned thenable ---------
    if (isLazyWrapper(value)) {
      destructiveModels.push(value);
      return renderModelDestructive(task, parent, key, value._init());
    }

    // -- Promises / thenables ----------------------------------------------
    if (isThenable(value)) {
      const id = serializeThenable(task, value);
      const reference = serializePromiseID(id);
      task.request.writtenObjects.set(value, reference);
      return reference;
    }

    // -- Arrays / plain objects --------------------------------------------
    if (Array.isArray(value) || isPlainObject(value)) {
      return value;
    }

    throw new Error("Unsupported object type in RSC payload.");
  }

  // -- Primitives -----------------------------------------------------------
  if (typeof value === "string") return serializeString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "undefined") return SERIALIZED_UNDEFINED;
  if (typeof value === "bigint") return serializeBigInt(value);
  if (typeof value === "symbol") {
    if (Symbol.for(value.description as string) !== value) {
      throw new Error("Only Symbol.for(...) symbols can be serialized.");
    }
    return serializeSymbol(value);
  }
  if (typeof value === "function") {
    if (isClientReference(value))
      return serializeClientReference(task.request, value as ClientReference, parent, key);
    if (isServerReference(value))
      return serializeServerReference(task.request, value as ServerReference);
    throw new Error(
      'Functions cannot be passed to Client Components unless marked with "use server".',
    );
  }

  throw new Error("Unsupported type in RSC payload: " + typeof value);
}

function renderModel(task: Task, parent: Any, key: string, value: Any): Any {
  try {
    destructiveModels = [];
    return renderModelDestructive(task, parent, key, value);
  } catch (thrownValue) {
    const request = task.request;

    if (isThenable(thrownValue)) {
      const newTask = task.createSubTask(destructiveModels[destructiveModels.length - 1]);
      const ping = () => newTask.ping();
      thrownValue.then(ping, ping);

      const reference = serializeLazyID(newTask.id);
      trackSuspendedModels(destructiveModels, newTask);
      return reference;
    }

    // A real error: emit an error row and reference it.
    request.pendingChunks++;
    const errorId = request.nextId++;
    emitErrorChunk(request, errorId, thrownValue);
    return serializeByValueID(errorId);
  }
}

function resolveModel(task: Task, rendered: Any): Any {
  // Already an encoded leaf (a string / number / boolean / reference).
  if (rendered === null || typeof rendered !== "object") return rendered;

  // Walk raw containers or react elements.
  if (Array.isArray(rendered)) {
    const out: Any[] = [];
    for (let i = 0; i < rendered.length; i++) {
      out[i] = resolveModel(task, renderModel(task, rendered, "" + i, rendered[i]));
    }
    return out;
  }
  const out: Record<string, Any> = {};
  for (const k in rendered) {
    if (hasOwn(rendered, k)) {
      out[k] = resolveModel(task, renderModel(task, rendered, k, rendered[k]));
    }
  }
  return out;
}

function reuseRef(task: Task, parent: Any, key: string, value: object): string | undefined {
  const reference = task.request.writtenObjects.get(value);
  if (!reference) {
    registerRef(task, parent, key, value);
    return undefined;
  }
  // A task retry renders the same model, but the first try already registered it
  // and the next would make the row point at itself.
  if (!parent && reference === serializeByValueID(task.id)) return undefined;
  return reference;
}

function registerRef(task: Task, parent: Any, key: string, value: object): void {
  let reference: string;
  if (parent) {
    const parentReference = task.request.writtenObjects.get(parent)!;
    let propertyName = key;
    if (Array.isArray(parent) && parent[0] === REACT_ELEMENT_TYPE) {
      if (key === "1") propertyName = "type";
      else if (key === "2") propertyName = "key";
      else if (key === "3") propertyName = "props";
    }
    if (propertyName.indexOf(":") !== -1) return;
    reference = parentReference + ":" + propertyName;
  } else {
    reference = serializeByValueID(task.id);
  }

  task.request.writtenObjects.set(value, reference);
}

function serializeThenable(task: Task, thenable: Thenable): number {
  switch (thenable.status) {
    case "fulfilled": {
      const newTask = task.createSubTask(thenable.value);
      newTask.ping();
      return newTask.id;
    }
    case "rejected": {
      const newTask = task.createSubTask();
      erroredTask(newTask, thenable.reason);
      return newTask.id;
    }
    default: {
      const newTask = task.createSubTask();
      if (typeof thenable.status !== "string") {
        thenable.status = "pending";
        thenable.then(
          (value: Any) => {
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
      thenable.then(
        (resolved: Any) => {
          newTask.model = resolved;
          newTask.ping();
        },
        (reason: Any) => {
          erroredTask(newTask, reason);
        },
      );
      return newTask.id;
    }
  }
}

/**
 * Emit the metadata row for a client reference and return a reference to it.
 *
 * Deduped by *key* (module id + export name): two references to the same module
 * — even two distinct function objects — share one import row. When the
 * reference is an element's `type`, a *lazy* reference is used so React can
 * suspend on the component until its code loads.
 */
function serializeClientReference(
  request: Request,
  ref: ClientReference,
  parent: Any,
  key: string,
): string {
  const meta = clientReferenceMeta(ref);
  const clientReferenceKey = meta.id + "#" + meta.name;
  const isElementType = Array.isArray(parent) && parent[0] === REACT_ELEMENT_TYPE && key === "1";

  const existingId = request.writtenClientReferences.get(clientReferenceKey);
  if (existingId !== undefined) {
    return isElementType ? serializeLazyID(existingId) : serializeByValueID(existingId);
  }

  request.pendingChunks++;
  const importId = request.nextId++;
  const json = JSON.stringify(meta);
  emitModelChunk(request, importId, json, "I");
  request.writtenClientReferences.set(clientReferenceKey, importId);
  return isElementType ? serializeLazyID(importId) : serializeByValueID(importId);
}

function serializeServerReference(request: Request, ref: ServerReference): string {
  const existingId = request.writtenServerReferences.get(ref);
  if (existingId !== undefined) return serializeServerReferenceID(existingId);

  request.pendingChunks++;
  const metadataId = request.nextId++;
  const json = JSON.stringify(serverReferenceMeta(ref));
  emitModelChunk(request, metadataId, json);
  request.writtenServerReferences.set(ref, metadataId);
  return serializeServerReferenceID(metadataId);
}

// ---- Emitting rows ---------------------------------------------------------

function emitModelChunk(request: Request, id: number, json: string, tag: RowTag = ""): void {
  request.completedChunks.push(request.encoder.encode(encodeRow(id, tag, json)));
}

function emitErrorChunk(request: Request, id: number, error: Any): void {
  emitModelChunk(
    request,
    id,
    JSON.stringify({
      digest: "",
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
    }),
    "E",
  );
}

/** Write out every completed row; close the stream when no work is left. */
function flushCompletedChunks(request: Request): void {
  const destination = request.destination;
  if (request.completedChunks.length > 0) {
    const completedChunks = request.completedChunks;
    request.completedChunks = [];
    for (const chunk of completedChunks) {
      destination.enqueue(chunk);
      request.pendingChunks--;
    }
  }
  if (request.pendingChunks === 0 && request.status !== "closed") {
    request.status = "closed";
    destination.close();
  }
}

/** Stop the request: drop queued work and abort every task still pending. */
function abortRequest(request: Request): void {
  request.status = "closed";
  request.pingedTasks = [];
  request.completedChunks = [];
  for (const task of request.abortableTasks) {
    if (task.status === "pending") {
      task.setStatus("aborted");
    }
  }
  request.abortableTasks.clear();
}

// ---- Public entry point — the `renderToReadableStream` ---------------------

export interface RenderToReadableStreamOptions {
  /** Encodes emitted rows. Defaults to `new TextEncoder()`. */
  encoder?: TextEncoder;
}

/**
 * Serialize `model` (any Server-Component tree / data) into a stream of Flight rows.
 *
 * [`renderToReadableStream`](https://github.com/react/react/blob/v19.3.0/packages/react-server-dom-webpack/src/server/ReactFlightDOMServerEdge.js#L118).
 */
export function renderToReadableStream(
  model: Any,
  options: RenderToReadableStreamOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = options.encoder ?? new TextEncoder();
  let request: Request;

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        request = new Request(model, encoder, controller);
        request.startWork();
      },
      pull() {
        flushCompletedChunks(request);
      },
      cancel() {
        abortRequest(request);
      },
    },
    { highWaterMark: 0 },
  );
}
