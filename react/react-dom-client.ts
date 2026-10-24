/**
 * The DOM host, `createRoot` and `hydrateRoot`.
 */

import {
  createRenderer,
  type HostConfig,
  type HydrationNode,
  type PatchConfig,
} from "./react-dom-core.ts";
import type { Any, Thenable } from "./shared.ts";

export interface ReactDomRoot {
  /** Mount `element`. A later `render` patches the tree the root already holds. */
  render(element: Any): void;
  /** Remove everything this root rendered. */
  unmount(): void;
}

function describeHydrationNode(node: Node): HydrationNode<Node> {
  switch (node.nodeType) {
    case 1:
      return { instance: node, kind: "element", value: (node as Element).tagName.toLowerCase() };
    case 3:
      return { instance: node, kind: "text", value: (node as Text).data };
    case 8:
      return { instance: node, kind: "comment", value: (node as Comment).data };
    default:
      return { instance: node, kind: "other", value: "" };
  }
}

function createDomHost(document: Document, container: Element): HostConfig<Element, Node> {
  /** Where the current pass stands in each container's original children. */
  const cursors = new Map<Node, number>();
  const originals = new Map<Node, Node[]>();
  const visited = new Map<Node, Set<Node>>();

  /** The node each path holds, so a pass updates it instead of rebuilding it. */
  const mounted = new Map<string, Node>();
  /** The keys this pass reached; a key it never reached has been unmounted. */
  const reached = new Set<string>();
  /** Index of the next child of each container, so a kept child is not moved. */
  const placed = new Map<Node, number>();
  /** The listeners this module attached; an element cannot list them back. */
  const attached = new WeakMap<Node, Map<string, Any>>();
  /** The `innerHTML` last written, so an unchanged string is not written again. */
  const writtenHTML = new WeakMap<Node, string>();
  let patching = false;

  /** Everything before `index` is settled, so `index` is where the next child goes. */
  function place(parent: Node, child: Node): void {
    const index = placed.get(parent) ?? 0;
    const reference: Node | null = parent.childNodes[index] ?? null;
    // A child already at the cursor keeps its place; anything else moves here.
    if (child !== reference) parent.insertBefore(child, reference);
    placed.set(parent, index + 1);
  }

  function dropRemaining(parent: Node): void {
    // Everything from the cursor on is output this pass did not emit.
    let stale: Node | null = parent.childNodes[placed.get(parent) ?? 0] ?? null;
    while (stale !== null) {
      const next: Node | null = stale.nextSibling;
      parent.removeChild(stale);
      stale = next;
    }
    // The element owns its children now, so a later identical `innerHTML` still applies.
    writtenHTML.delete(parent);
    placed.delete(parent);
  }

  const patch: PatchConfig<Element, Node> = {
    begin() {
      patching = true;
      reached.clear();
      placed.clear();
    },
    end(prefix?: string) {
      patching = false;
      placed.clear();
      for (const key of mounted.keys()) {
        // A scoped pass only owns the keys it could have rendered.
        if (prefix !== undefined && !key.startsWith(prefix)) continue;
        if (!reached.has(key)) mounted.delete(key);
      }
      reached.clear();
    },
    claim: (key) => mounted.get(key) ?? null,
    position: (parent) => placed.get(parent as Node) ?? 0,
    positionAt: (parent, index) => {
      placed.set(parent as Node, index);
    },
    positionOf: (parent, node) =>
      [...(parent as Node).childNodes].indexOf(node as unknown as ChildNode),
    nodesBetween: (parent, start) => {
      const end = placed.get(parent as Node) ?? 0;
      return [...(parent as Node).childNodes].slice(start, end);
    },
    remove: (parent, node) => {
      const nodeParent = parent as Node;
      if ((node as Node).parentNode === nodeParent) nodeParent.removeChild(node as Node);
    },
    retain(key, node) {
      reached.add(key);
      mounted.set(key, node);
    },
    updateText(node, text) {
      if ((node as Text).data !== text) (node as Text).data = text;
    },
    updateProperties(node, properties) {
      const element = node as Element;
      // An attribute the new props no longer carry is stale.
      const wanted = new Map(properties.attributes);
      for (const name of element.getAttributeNames()) {
        if (!wanted.has(name)) element.removeAttribute(name);
      }
      for (const [name, value] of wanted) {
        if (element.getAttribute(name) !== value) element.setAttribute(name, value);
      }
      // A changed listener is swapped, never added beside the old one.
      const previous = attached.get(node) ?? new Map<string, Any>();
      const next = new Map<string, Any>(properties.events);
      for (const [type, listener] of previous) {
        if (next.get(type) !== listener) element.removeEventListener(type, listener);
      }
      for (const [type, listener] of next) {
        if (previous.get(type) !== listener) element.addEventListener(type, listener);
      }
      attached.set(node, next);
      if (properties.innerHTML !== null && writtenHTML.get(node) !== properties.innerHTML) {
        element.innerHTML = properties.innerHTML;
        writtenHTML.set(node, properties.innerHTML);
      }
    },
    finishChildren: (parent) => dropRemaining(parent as Node),
    reset() {
      patching = false;
      mounted.clear();
      reached.clear();
      placed.clear();
    },
  };

  function originalChildren(parent: Node): Node[] {
    let children = originals.get(parent);
    if (children === undefined) {
      children = [...parent.childNodes];
      originals.set(parent, children);
    }
    return children;
  }

  function markVisited(parent: Node, node: Node): void {
    let seen = visited.get(parent);
    if (seen === undefined) {
      seen = new Set();
      visited.set(parent, seen);
    }
    seen.add(node);
  }

  return {
    createRoot: () => container,
    createInstance: (tag) => document.createElement(tag),
    createTextInstance: (text) => document.createTextNode(text),
    appendChild: (parent, child) => {
      // Every append follows the pass cursor, so a kept child is not moved.
      place(parent as Node, child as Node);
    },
    setInitialProperties: (instance, properties) => {
      // Only elements reach here; text nodes have no properties.
      const element = instance as Element;
      for (const [name, value] of properties.attributes) element.setAttribute(name, value);
      const listeners = new Map<string, Any>();
      for (const [type, listener] of properties.events) {
        element.addEventListener(type, listener);
        listeners.set(type, listener);
      }
      if (listeners.size > 0) attached.set(instance, listeners);
      if (properties.innerHTML !== null) writtenHTML.set(instance, properties.innerHTML);
    },
    setInnerHTML: (instance, html) => {
      (instance as Element).innerHTML = html;
      writtenHTML.set(instance, html);
    },
    createStagingRoot: () => document.createDocumentFragment(),
    commitStaged: (parent, staged, reference) => {
      if (patching && reference === undefined) {
        // Staged children take the parent's cursor, so they keep their order.
        for (const child of [...(staged as Node).childNodes]) place(parent as Node, child);
        return;
      }
      // `insertBefore` with a null reference appends, as the staging path expects.
      (parent as Node).insertBefore(staged as Node, (reference as Node | null) ?? null);
    },
    clearBetween: (parent, start, end) => {
      const nodeParent = parent as Node;
      let node = (start as Node).nextSibling;
      while (node !== null && node !== (end as Node)) {
        const next = node.nextSibling;
        nodeParent.removeChild(node);
        node = next;
      }
    },
    createCommentInstance: (text) => document.createComment(text),
    setCommentText: (instance, text) => {
      (instance as Comment).data = text;
    },
    getCommentText: (instance) => (instance as Comment).data,
    patch,
    hydration: {
      begin() {
        cursors.clear();
        originals.clear();
        visited.clear();
      },
      next(parent) {
        const nodeParent = parent as Node;
        const children = originalChildren(nodeParent);
        const index = cursors.get(nodeParent) ?? 0;
        if (index >= children.length) return null;
        return describeHydrationNode(children[index]);
      },
      accept(parent, node) {
        const nodeParent = parent as Node;
        cursors.set(nodeParent, (cursors.get(nodeParent) ?? 0) + 1);
        markVisited(nodeParent, node.instance);
      },
      skip(parent, node) {
        // Kept for a deferred boundary; only the cursor moves.
        const nodeParent = parent as Node;
        cursors.set(nodeParent, (cursors.get(nodeParent) ?? 0) + 1);
        markVisited(nodeParent, node.instance);
      },
      drop(parent, node) {
        const nodeParent = parent as Node;
        cursors.set(nodeParent, (cursors.get(nodeParent) ?? 0) + 1);
        markVisited(nodeParent, node.instance);
        if (node.instance.parentNode === nodeParent) nodeParent.removeChild(node.instance);
      },
      finish() {
        // Anything the pass never reached is stale server output.
        for (const [parent, children] of originals) {
          const seen = visited.get(parent);
          for (const child of children) {
            if (seen !== undefined && seen.has(child)) continue;
            if (child.parentNode === parent) parent.removeChild(child);
          }
        }
        cursors.clear();
        originals.clear();
        visited.clear();
      },
      clear(root) {
        clearChildren(root as Element);
      },
      beginScope(parent, marker) {
        // A retry re-reads the live children, which may include Fizz's reveal.
        const nodeParent = parent as Node;
        const children = [...nodeParent.childNodes];
        originals.set(nodeParent, children);
        cursors.set(nodeParent, children.indexOf(marker as ChildNode) + 1);
      },
      endScope() {
        // A scoped pass never prunes: unclaimed nodes belong to the boundary
        // it was asked to inspect, not to stale output.
        cursors.clear();
        originals.clear();
        visited.clear();
      },
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
  const controls = createRootControls(container);
  return {
    render: (element) => controls.render(element),
    unmount: () => controls.unmount(),
  };
}

/**
 * Adopt markup the server already rendered into `container`. Later renders
 * patch that markup as `createRoot` does, keeping the hook state they already hold.
 */
export function hydrateRoot(container: Element, element: Any): ReactDomRoot {
  const controls = createRootControls(container);
  controls.hydrate(element);
  return {
    render: (next) => controls.render(next),
    unmount: () => controls.unmount(),
  };
}

interface RootControls {
  render(element: Any): void;
  hydrate(element: Any): void;
  unmount(): void;
}

function createRootControls(container: Element): RootControls {
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

  const renderer = createRenderer<Element, Node>(createDomHost(document, container), {
    rerender: () => rerender(),
    onSuspend: retryWhenSettled,
  });

  function retryWhenSettled(thenable: Thenable, retry: () => void): void {
    if (waiting.has(thenable)) return;
    waiting.add(thenable);
    const rerun = (): void => {
      waiting.delete(thenable);
      if (mounted) retry();
    };
    // A rejection retries too: `use()` throws the reason on the next pass.
    thenable.then(rerun, rerun);
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
        // The renderer patches the tree in place; unmounting is what clears it.
        renderer.render(rootElement);
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
    hydrate(element: Any): void {
      rootElement = element;
      mounted = true;
      renderer.hydrate(element, container);
    },
    unmount(): void {
      clearChildren(container);
      renderer.reset();
      waiting.clear();
      mounted = false;
      rootElement = null;
    },
  };
}
