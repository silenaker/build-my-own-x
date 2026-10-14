/**
 * an incremental RSC deserializer.
 *
 * Every row is a "chunk", and a chunk is itself a thenable. When a value refers
 * to a row that has not arrived yet (`$L1`, `$@2`, `$3:path`), it is converted to
 * something which wrap the pending chunk that will be settled later
 * (a lazy wrapper, the chunk itself, or a lazy getter).
 *
 */

import {
  NOT_A_PRIMITIVE,
  decodePrimitive,
  parseReference,
  parseRow,
  splitRows,
} from "./react-flight-protocol.ts";
import {
  REACT_ELEMENT_TYPE,
  clientReferenceMeta,
  clientReferenceValue,
  createLazyWrapper,
  isClientReference,
  isLazyWrapper,
  type ClientReferenceMeta,
  type LazyWrapper,
} from "./react.ts";
import { isThenable, type Any, type Thenable } from "./shared.ts";

/** Lifecycle of a chunk (one row). */
export type ChunkStatus = "pending" | "parsed" | "resolved" | "errored";

/** Returned by `reviveModel` when it installed a lazy getter instead of returning a value. */
const NO_VALUE: unique symbol = Symbol("react-flight.noValue");

export interface ReadOptions {
  /** Called for each raw row as it is read. */
  onRow?: (row: string) => void;
  /**
   * Client modules keyed by bundler id. A client reference resolves to
   * `clientModules[id][exportName]`.
   */
  clientModules?: Record<string, Record<string, Any>>;
  /**
   * Resolve a client reference yourself. Takes priority over `clientModules`.
   * Return `undefined` to fall through to `clientModules`.
   *
   * May return a thenable (e.g. while the module chunk loads); the client then
   * suspends on it and retries once it settles.
   */
  resolveClientComponent?: (meta: ClientReferenceMeta) => Any | Thenable<Any>;
}

export class Chunk<T = Any> {
  /** The row id. */
  id: number;
  /** The chunk status. */
  status: ChunkStatus = "pending";
  /** Row kind. */
  tag: "" | "I" | "E" = "";
  /** Parsed JSON payload, once the row has arrived. */
  raw: Any;
  /** The resolved value after `raw` payload revived. */
  value: T | undefined;
  /** The error once chunk is rejected. */
  reason: Any;

  _promise: Promise<T> | null = null;
  _promiseResolve: ((value: T) => void) | null = null;
  _promiseReject: ((reason: Any) => void) | null = null;

  constructor(id: number) {
    this.id = id;
  }

  then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: Any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.getPromise().then(onFulfilled, onRejected);
  }

  getPromise(): Promise<T> {
    if (this._promise === null) {
      this._promise = new Promise<T>((resolve, reject) => {
        if (this.status === "resolved") resolve(this.value as T);
        else if (this.status === "errored") reject(this.reason);
        else {
          this._promiseResolve = resolve;
          this._promiseReject = reject;
        }
      });
      // Don't crash the process if nobody subscribed to an errored chunk.
      this._promise.catch(() => {});
    }
    return this._promise;
  }

  resolveWith(value: T): void {
    if (this.status === "resolved" || this.status === "errored") return;
    this.status = "resolved";
    this.value = value;
    if (this._promiseResolve) this._promiseResolve(value);
  }

  rejectWith(reason: Any): void {
    if (this.status === "errored") return;
    this.status = "errored";
    this.reason = reason;
    if (this._promiseReject) this._promiseReject(reason);
  }
}

class Response {
  options: ReadOptions;
  /** Chunks by row id. */
  chunks: Map<number, Chunk>;

  constructor(options?: ReadOptions) {
    this.options = options || {};
    this.chunks = new Map();
  }

  /** Get a chunk, creating a pending chunk if the row has not arrived. */
  getChunk(id: number): Chunk {
    let chunk = this.chunks.get(id);
    if (chunk === undefined) {
      chunk = new Chunk(id);
      this.chunks.set(id, chunk);
    }
    return chunk;
  }

  /** Read the stream, resolving chunks as rows arrive. */
  startReading(stream: ReadableStream<Uint8Array>): void {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = "";

    const consume = (): void => {
      const { rows, rest } = splitRows(buffer);
      buffer = rest; // keep the trailing, possibly partial, row
      for (const row of rows) {
        if (row.length === 0) continue;
        this.options.onRow?.(row);
        this.pushRow(row);
      }
    };

    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          consume();
        }
        if (buffer.length > 0) {
          this.options.onRow?.(buffer);
          this.pushRow(buffer);
        }
      } catch (error) {
        // Fail everything that was still waiting on a row.
        for (const chunk of this.chunks.values()) {
          if (chunk.status === "pending" || chunk.status === "parsed") chunk.rejectWith(error);
        }
      }
    })();
  }

  pushRow(row: string): void {
    const { id, tag, payload } = parseRow(row);
    const chunk = this.getChunk(id);
    chunk.tag = tag;
    chunk.raw = payload;
    chunk.status = "parsed";
    this.resolveModelChunk(chunk);
  }

  resolveModelChunk(chunk: Chunk): void {
    if (chunk.status !== "parsed") return;
    try {
      let value: Any;
      if (chunk.tag === "I") {
        value = clientReferenceValue(chunk.raw as ClientReferenceMeta);
      } else if (chunk.tag === "E") {
        throw new Error("Server error: " + chunk.raw.message);
      } else {
        value = this.reviveModel(chunk.raw, chunk, null, null);
      }
      chunk.resolveWith(value);
    } catch (error) {
      chunk.rejectWith(error);
    }
  }

  reviveModel(raw: Any, chunk: Chunk, parent: Any, key: string | number | null): Any {
    if (typeof raw === "string") return this.parseModelString(raw, parent, key);
    if (raw === null || typeof raw !== "object") return raw;

    if (Array.isArray(raw) && raw[0] === "$") {
      raw = { $$typeof: REACT_ELEMENT_TYPE, type: raw[1], key: raw[2], props: raw[3] };
    }

    if (Array.isArray(raw)) {
      const out: Any[] = Array.from({ length: raw.length });
      for (let i = 0; i < raw.length; i++) {
        const value = this.reviveModel(raw[i], chunk, out, i);
        if (value !== NO_VALUE) out[i] = value;
      }
      return out;
    }

    const out: Record<string, Any> = {};
    for (const k of Object.keys(raw)) {
      const value = this.reviveModel(raw[k], chunk, out, k);
      if (value !== NO_VALUE) out[k] = value;
    }
    return out;
  }

  parseModelString(str: string, parent: Any, key: string | number | null): Any {
    const primitive = decodePrimitive(str);
    if (primitive !== NOT_A_PRIMITIVE) return primitive;

    const { tag, id, path } = parseReference(str);
    switch (tag) {
      case "L": // lazy: hand back a React.lazy-shaped wrapper
        return this.createLazyWrapperForChunk(this.getChunk(id));
      case "@": // promise: the chunk itself *is* the thenable
        return this.getChunk(id);
      default: // read referent value or define getter when the referent chunk is not ready
        return this.readReference(id, path, parent, key);
    }
  }

  /** Resolve a `$id` / `$id:path` reference. */
  readReference(id: number, path: string[], parent: Any, key: string | number | null): Any {
    const target = this.getChunk(id);
    if (target.status === "errored") throw target.reason;
    if (target.status === "resolved") return walkPath(target.value, path);

    const getter = () => {
      if (target.status === "errored") throw target.reason;
      if (target.status !== "resolved") {
        // Can't happen: the server writes the referent row before any row that
        // references it, and a gated slot is only read after its row resolved.
        throw new Error(
          "Read $" +
            id +
            (path.length > 0 ? ":" + path.join(":") : "") +
            " before its chunk resolved (status: " +
            target.status +
            ").",
        );
      }
      return walkPath(target.value, path);
    };
    if (parent == null || key == null) {
      return getter();
    }
    // for referent in self row.
    Object.defineProperty(parent, key, {
      configurable: true,
      enumerable: true,
      get: getter,
      set: (newValue: Any) => {
        Object.defineProperty(parent, key, {
          value: newValue,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      },
    });
    return NO_VALUE;
  }

  resolveClientReference(meta: ClientReferenceMeta): Any | Thenable<Any> {
    const resolved = this.options.resolveClientComponent?.(meta);
    if (resolved !== undefined) return resolved;

    const exported = this.options.clientModules?.[meta.id]?.[meta.name ?? "default"];
    if (exported !== undefined) return exported;

    throw new Error(
      'Could not resolve the client reference "' +
        meta.id +
        "#" +
        meta.name +
        '". Pass it through options.clientModules or options.resolveClientComponent.',
    );
  }

  /** A `React.lazy`-shaped wrapper around a chunk. */
  createLazyWrapperForChunk(chunk: Chunk): LazyWrapper {
    let moduleValue: Any;
    let moduleResolved = false;
    let moduleError: Any;
    let moduleErrored = false;

    return createLazyWrapper(() => {
      if (chunk.status === "errored") throw chunk.reason;
      if (chunk.status !== "resolved") {
        throw chunk;
      }

      const value = chunk.value;
      // An `I` row resolved to a client reference. Resolve it to the actual client
      // module export here.
      if (!isClientReference(value)) return value;

      if (!moduleResolved && !moduleErrored) {
        if (moduleValue === undefined) {
          const resolved = this.resolveClientReference(clientReferenceMeta(value));
          if (isThenable(resolved)) {
            moduleValue = resolved;
            resolved.then(
              (exported) => {
                moduleValue = exported;
                moduleResolved = true;
              },
              (error) => {
                moduleError = error;
                moduleErrored = true;
              },
            );
          } else {
            moduleValue = resolved;
            moduleResolved = true;
          }
        }
        // Still in flight: throw the thenable.
        if (!moduleResolved && !moduleErrored) throw moduleValue;
      }
      if (moduleErrored) throw moduleError;
      return moduleValue;
    });
  }
}

/** Walk a path into a resolved value. */
function walkPath(value: Any, path: string[]): Any {
  for (const segment of path) value = value[segment];
  return value;
}

/** Read a Flight stream and return the root chunk (row 0) immediately. */
export function createFromReadableStream(
  stream: ReadableStream<Uint8Array>,
  options: ReadOptions = {},
): Chunk {
  const response = new Response(options);
  response.startReading(stream);
  return response.getChunk(0);
}

/**
 * Settle every pending piece of a resolved model recursively
 * (thenables, lazy wrappers, and lazy getters) so you get a
 * fully concrete value.
 */
export async function deepAwait(value: Any, seen: Map<object, Any> = new Map()): Promise<Any> {
  if (isThenable(value)) return deepAwait(await value, seen);
  if (value === null || typeof value !== "object") return value;

  if (isLazyWrapper(value)) {
    return readSlot(() => value._init(), seen);
  }

  if (seen.has(value)) return seen.get(value);
  seen.set(value, value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = await readSlot(() => value[i], seen);
    return value;
  }
  for (const k of Object.keys(value)) value[k] = await readSlot(() => value[k], seen);
  return value;
}

/** Read a slot, suspending (throw the chunk) and retrying if it isn't ready. */
async function readSlot(produce: () => Any, seen: Map<object, Any>): Promise<Any> {
  for (;;) {
    try {
      return await deepAwait(produce(), seen);
    } catch (thrown) {
      if (!isThenable(thrown)) throw thrown;
      await thrown;
    }
  }
}
