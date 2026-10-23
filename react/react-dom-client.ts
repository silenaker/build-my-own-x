/**
 * The DOM host, `createRoot` and `hydrateRoot`.
 */

import { createRenderer, type HostConfig, type HydrationNode } from "./react-dom-core.ts";
import type { Any, Thenable } from "./shared.ts";

export interface ReactDomRoot {
  /** Mount `element`. A later `render` replaces the whole tree. */
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
    commitStaged: (parent, staged, reference) => {
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
 * replace the tree as `createRoot` does, keeping the hook state they already hold.
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
        clearChildren(container);
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
