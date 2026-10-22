/**
 * Streaming HTML and prerendering.
 *
 * Streaming writes the shell as soon as it is ready and completes suspended
 * boundaries afterwards, out of order. Prerendering waits for every boundary and
 * returns one finished document, so it can inline the content.
 */

import { Readable } from "node:stream";
import { createRenderer, type BoundaryTracker, type HostConfig } from "./react-dom-core.ts";
import { isThenable, type Any, type Thenable } from "./shared.ts";

export interface ServerOptions {
  /** Stops the work; a stream closes with whatever the shell already holds. */
  signal?: AbortSignal;
  /** Receives errors a boundary swallowed, so the rest of the shell keeps rendering. */
  onError?: (error: Any) => void;
  /** Prefixes boundary ids, so two renders on one page cannot collide. */
  identifierPrefix?: string;
}

export type RenderToReadableStreamOptions = ServerOptions;

/** What a prerender still owes. This toy records the boundary ids only; React also replays the tree. */
export interface PostponedState {
  /** Boundaries left as `$?` in the prelude. */
  boundaries: number[];
}

export interface PrerenderResult {
  /** The finished HTML, ready to send. */
  prelude: ReadableStream<Uint8Array>;
  /** `null` once every boundary is in `prelude`. */
  postponed: PostponedState | null;
}

export interface PrerenderNodeResult {
  prelude: Readable;
  postponed: PostponedState | null;
}

// ---- The HTML host ---------------------------------------------------------

export interface HtmlRoot {
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
interface HtmlComment {
  kind: "comment";
  data: string;
}
export type HtmlNode = HtmlElement | HtmlText | HtmlComment;

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
  createCommentInstance: (text) => ({ kind: "comment", data: text }),
  setCommentText: (instance, text) => {
    if (instance.kind === "comment") instance.data = text;
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
  if (node.kind === "comment") return "<!--" + node.data + "-->";

  const attributes = node.attributes
    .map(([name, value]) => " " + name + '="' + escapeText(value) + '"')
    .join("");
  if (VOID_ELEMENTS.has(node.tag.toLowerCase())) return "<" + node.tag + attributes + "/>";

  const content =
    node.innerHTML !== null ? node.innerHTML : node.children.map(serializeNode).join("");
  return "<" + node.tag + attributes + ">" + content + "</" + node.tag + ">";
}

/**
 * Render once and serialize the result.
 *
 * [`renderToString`](https://github.com/react/react/blob/v19.3.0/packages/react-dom/src/server/ReactDOMLegacyServerBrowser.js#L18).
 */
export function renderToString(element: Any): string {
  return serializeNode(createRenderer(htmlHost).render(element));
}

/** A renderer that keeps component instances between passes, for server targets. */
export interface HtmlServerRenderer {
  /** Render one pass; the returned tree is that pass's shell. */
  render(element: Any): HtmlRoot;
  /** Serialize a shell or one boundary's staged content. */
  serialize(root: HtmlRoot | HtmlNode): string;
}

/**
 * Streaming retries one boundary at a time, while prerender runs a new pass;
 * both need the hooks the previous pass mounted, so they share this renderer.
 */
function createHtmlServerRenderer(
  boundaries: BoundaryTracker<HtmlRoot, HtmlNode>,
  onError?: (error: Any) => void,
): HtmlServerRenderer {
  const renderer = createRenderer(htmlHost, { boundaries, onError });
  return {
    render: (element) => renderer.render(element),
    serialize: serializeNode,
  };
}

/** Where the request writes; the controller only exists once the stream does. */
interface Destination {
  write(text: string): void;
  close(): void;
}

interface PendingBoundary {
  id: number;
  /** The retry waits for this; a second suspension replaces it. */
  thenable: Thenable;
  /** Render the children into a detached root, with the same keys as before. */
  retry: () => HtmlRoot | HtmlNode;
  ready: boolean;
}

/**
 * Runs in the page: move a completed boundary's content into the placeholder
 * and turn its `$?` marker into `$`.
 */
function revealBoundary(boundaryId: string, contentId: string): void {
  const template = document.getElementById(boundaryId);
  const content = document.getElementById(contentId);
  // Hydration and a cancelled boundary can both remove either node.
  if (template === null || content === null) return;

  // The boundary starts at the comment right before its template.
  const marker = template.previousSibling as Comment | null;
  const parent = marker === null ? null : marker.parentNode;
  if (marker === null || parent === null) return;

  // A fallback can hold nested boundaries, so the matching end needs a depth count.
  let end: Node | null = template;
  let depth = 0;
  while (end !== null) {
    if (end.nodeType === Node.COMMENT_NODE) {
      const data = (end as Comment).data;
      if (data === "/$" || data === "/&") {
        if (depth === 0) break;
        depth--;
      } else if (data === "$" || data === "$?" || data === "$~" || data === "$!" || data === "&") {
        depth++;
      }
    }
    end = end.nextSibling;
  }
  if (end === null) return;

  // Drop the template and the fallback, then move the content into their place.
  while (marker.nextSibling !== null && marker.nextSibling !== end) {
    parent.removeChild(marker.nextSibling);
  }
  while (content.firstChild !== null) {
    parent.insertBefore(content.firstChild, end);
  }

  marker.data = "$";
  const contentParent = content.parentNode;
  if (contentParent !== null) contentParent.removeChild(content);
}

/**
 * Runs in the page: the server gave up on this boundary, so the fallback stays
 * and the client renders it.
 */
function clientRenderBoundary(boundaryId: string, message: string): void {
  const template = document.getElementById(boundaryId);
  if (template === null) return;

  const marker = template.previousSibling;
  if (marker !== null) (marker as Comment).data = "$!";
  template.setAttribute("data-dgst", "");
  template.setAttribute("data-msg", message);
}

/**
 * The instructions travel as source, so the shell needs no shared runtime.
 * Both functions only touch globals, which keeps `toString()` self-contained.
 */
const REVEAL_BOUNDARY = revealBoundary.toString();
const CLIENT_RENDER_BOUNDARY = clientRenderBoundary.toString();

/** A self-contained script call, so the page needs no global runtime. */
function inlineCall(fn: string, ...args: string[]): string {
  return "<script>(" + fn + ")(" + args.map((arg) => JSON.stringify(arg)).join(",") + ")</script>";
}

function errorMessage(error: Any): string {
  return error instanceof Error ? error.message : String(error);
}

class ServerRequest {
  private readonly options: ServerOptions;
  /** Streaming retries boundaries as they settle; prerendering re-renders the tree. */
  private readonly streaming: boolean;
  private readonly renderer: HtmlServerRenderer;
  private readonly tracker: BoundaryTracker<HtmlRoot, HtmlNode>;
  private readonly abortPromise: Promise<void>;
  private resolveAbort: () => void = () => {};
  /** Boundary key -> id, so a second pass names the same boundary. */
  private readonly boundaryIds = new Map<string, number>();
  /** The boundary whose staged content contains each boundary. */
  private readonly boundaryParents = new Map<number, number | null>();
  private nextBoundaryId = 0;
  /** Boundaries whose content this request still owes. */
  private pending = new Map<number, PendingBoundary>();
  /** Boundaries whose content is already in the document. */
  private committed = new Set<number>();
  private flushScheduled = false;
  private status: "open" | "closed" = "open";
  private aborted = false;
  private destination: Destination | null = null;
  private root: HtmlRoot | null = null;
  private shellWritten = false;

  constructor(options: ServerOptions, streaming: boolean) {
    this.options = options;
    this.streaming = streaming;
    this.abortPromise = new Promise((resolve) => {
      this.resolveAbort = resolve;
    });

    const signal = options.signal;
    if (signal !== undefined) {
      if (signal.aborted) {
        this.aborted = true;
      } else {
        signal.addEventListener("abort", () => this.handleAbort(), { once: true });
      }
    }

    const request = this;
    this.tracker = {
      parent: null,
      idFor(key) {
        let id = request.boundaryIds.get(key);
        if (id === undefined) {
          id = request.nextBoundaryId++;
          request.boundaryIds.set(key, id);
          request.boundaryParents.set(id, request.tracker.parent);
        }
        return id;
      },
      templateId(id) {
        return (request.options.identifierPrefix ?? "") + "B" + id;
      },
      postpone(id, thenable, retry) {
        request.postpone(id, thenable, retry);
      },
      finish(id) {
        request.committed.add(id);
      },
    };
    this.renderer = createHtmlServerRenderer(this.tracker, (error) => this.reportError(error));
  }

  // ---- Streaming ----------------------------------------------------------

  /** Render the shell, write it, and leave the pending boundaries armed. */
  startStreaming(element: Any, destination: Destination): void {
    this.destination = destination;
    if (this.aborted) {
      this.status = "closed";
      destination.close();
      return;
    }
    const root = this.renderShell(element);
    this.write(this.renderer.serialize(root));
    this.shellWritten = true;
    if (this.pending.size === 0) this.finishStream();
  }

  /** A consumer cancelled the stream; nothing more will be read. */
  abort(): void {
    this.handleAbort();
  }

  private handleAbort(): void {
    this.aborted = true;
    this.resolveAbort();
    // A prerender keeps its pending boundaries: they become the postponed state.
    if (!this.streaming || this.status !== "open") return;
    this.status = "closed";
    this.pending.clear();
    if (this.destination !== null) this.destination.close();
  }

  private write(text: string): void {
    if (this.status !== "open" || this.destination === null) return;
    this.destination.write(text);
  }

  private finishStream(): void {
    if (this.status !== "open") return;
    this.status = "closed";
    if (this.destination !== null) this.destination.close();
  }

  // ---- Prerender ----------------------------------------------------------

  /** Re-render until nothing suspends, so every boundary can be inlined. */
  async renderAll(element: Any): Promise<void> {
    if (this.aborted) return;
    while (true) {
      this.renderShell(element);
      if (this.pending.size === 0) return;
      await this.waitForPending();
      if (this.aborted) return;
    }
  }

  /** The next pass runs once every thenable this one threw has settled. */
  private waitForPending(): Promise<void> {
    const thenables = [...this.pending.values()].map((entry) => entry.thenable);
    return new Promise((resolve) => {
      let remaining = thenables.length;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const one = (): void => {
        remaining--;
        if (remaining === 0) finish();
      };
      for (const thenable of thenables) thenable.then(one, one);
      this.abortPromise.then(finish);
    });
  }

  getHtml(): string {
    return this.root === null ? "" : this.renderer.serialize(this.root);
  }

  getPostponedState(): PostponedState | null {
    if (this.pending.size === 0) return null;
    return { boundaries: [...this.pending.keys()].sort((a, b) => a - b) };
  }

  // ---- Boundaries ---------------------------------------------------------

  /** Render one pass from an empty tree, so markers from the last pass cannot pile up. */
  private renderShell(element: Any): HtmlRoot {
    this.pending = new Map();
    this.committed = new Set();
    this.tracker.parent = null;
    try {
      const root = this.renderer.render(element);
      this.root = root;
      return root;
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  private postpone(id: number, thenable: Thenable, retry: () => HtmlRoot | HtmlNode): void {
    // If this boundary suspends, its staged subtree is dropped, including any
    // pending descendants and completion state recorded inside that subtree.
    for (const childId of this.pending.keys()) {
      if (childId !== id && this.isDescendantOf(childId, id)) this.pending.delete(childId);
    }
    for (const committedId of this.committed) {
      if (this.isDescendantOf(committedId, id)) this.committed.delete(committedId);
    }

    const existing = this.pending.get(id);
    const entry: PendingBoundary = existing ?? {
      id,
      thenable,
      retry,
      ready: false,
    };
    entry.thenable = thenable;
    entry.retry = retry;
    entry.ready = false;
    this.pending.set(id, entry);

    // Prerendering waits for the whole set; only streaming completes one now.
    if (this.streaming) this.arm(entry);
  }

  private arm(entry: PendingBoundary): void {
    const ping = (): void => this.ping(entry.id);
    entry.thenable.then(ping, ping);
  }

  private ping(id: number): void {
    if (this.status !== "open") return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    entry.ready = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushReady();
    });
  }

  /** A child boundary's chunk cannot arrive before its parent's content. */
  private eligible(entry: PendingBoundary): boolean {
    let parent = this.boundaryParents.get(entry.id) ?? null;
    while (parent !== null) {
      if (!this.committed.has(parent)) return false;
      parent = this.boundaryParents.get(parent) ?? null;
    }
    return true;
  }

  private isDescendantOf(id: number, ancestorId: number): boolean {
    let parent = this.boundaryParents.get(id) ?? null;
    while (parent !== null) {
      if (parent === ancestorId) return true;
      parent = this.boundaryParents.get(parent) ?? null;
    }
    return false;
  }

  private flushReady(): void {
    let progress = true;
    while (progress && this.status === "open") {
      progress = false;
      for (const entry of [...this.pending.values()]) {
        if (!entry.ready || !this.eligible(entry)) continue;
        this.settle(entry);
        progress = true;
      }
    }
    if (this.pending.size === 0 && this.shellWritten) this.finishStream();
  }

  private settle(entry: PendingBoundary): void {
    let staged: HtmlRoot | HtmlNode;
    try {
      staged = entry.retry();
    } catch (thrown) {
      if (isThenable(thrown)) {
        // The retry reached another thenable; wait for that one instead.
        this.postpone(entry.id, thrown, entry.retry);
        return;
      }
      // The boundary cannot render on the server; leave the fallback and let
      // the client take over, as `$!` tells it to.
      this.reportError(thrown);
      this.write(
        inlineCall(CLIENT_RENDER_BOUNDARY, this.templateId(entry.id), errorMessage(thrown)),
      );
      this.commit(entry.id);
      return;
    }

    const contentId = this.contentId(entry.id);
    const html = this.renderer.serialize(staged);
    this.write(
      '<div hidden id="' +
        contentId +
        '">' +
        html +
        "</div>" +
        inlineCall(REVEAL_BOUNDARY, this.templateId(entry.id), contentId),
    );
    this.commit(entry.id);
  }

  private commit(id: number): void {
    this.pending.delete(id);
    this.committed.add(id);
  }

  private templateId(id: number): string {
    return (this.options.identifierPrefix ?? "") + "B" + id;
  }

  private contentId(id: number): string {
    return (this.options.identifierPrefix ?? "") + "S" + id;
  }

  private reportError(error: Any): void {
    const onError = this.options.onError;
    if (onError !== undefined) onError(error);
  }
}

/** Buffers writes until the readable side is attached. */
class StreamDestination implements Destination {
  private readonly encoder = new TextEncoder();
  private chunks: Uint8Array[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private closed = false;

  write(text: string): void {
    if (this.closed) return;
    const chunk = this.encoder.encode(text);
    if (this.controller === null) this.chunks.push(chunk);
    else this.controller.enqueue(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.controller !== null) this.controller.close();
  }

  createStream(onCancel: () => void): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller;
          for (const chunk of this.chunks) controller.enqueue(chunk);
          this.chunks = [];
          if (this.closed) controller.close();
        },
        cancel: () => {
          // Close first, so a late boundary completion does not enqueue.
          this.closed = true;
          onCancel();
        },
      },
      { highWaterMark: 0 },
    );
  }
}

/** Stream a shell now and complete suspended boundaries as their data settles. */
export async function renderToReadableStream(
  element: Any,
  options: RenderToReadableStreamOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const request = new ServerRequest(options, true);
  const destination = new StreamDestination();
  request.startStreaming(element, destination);
  return destination.createStream(() => request.abort());
}

/** Render every boundary, then hand back the finished HTML and what is still owed. */
async function renderStatic(
  element: Any,
  options: ServerOptions,
): Promise<{ html: string; postponed: PostponedState | null }> {
  const request = new ServerRequest(options, false);
  await request.renderAll(element);
  return { html: request.getHtml(), postponed: request.getPostponedState() };
}

/** Render a static document, waiting for every boundary to settle. */
export async function prerender(
  element: Any,
  options: ServerOptions = {},
): Promise<PrerenderResult> {
  const { html, postponed } = await renderStatic(element, options);
  const encoder = new TextEncoder();
  const prelude = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(html));
      controller.close();
    },
  });
  return { prelude, postponed };
}

/** Same as `prerender`, but the prelude is a Node `Readable`. */
export async function prerenderToNodeStream(
  element: Any,
  options: ServerOptions = {},
): Promise<PrerenderNodeResult> {
  const { html, postponed } = await renderStatic(element, options);
  return { prelude: Readable.from([html]), postponed };
}
