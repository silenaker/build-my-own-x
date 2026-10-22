/**
 * The DOM host and `createRoot`.
 */

import { createRenderer, type HostConfig } from "./react-dom-core.ts";
import type { Any, Thenable } from "./shared.ts";

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
    createCommentInstance: (text) => document.createComment(text),
    setCommentText: (instance, text) => {
      (instance as Comment).data = text;
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

  const renderer = createRenderer<Element, Node>(createDomHost(document, container), {
    rerender: () => rerender(),
    onSuspend: retryWhenSettled,
  });

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
    unmount(): void {
      clearChildren(container);
      renderer.reset();
      waiting.clear();
      mounted = false;
      rootElement = null;
    },
  };
}
