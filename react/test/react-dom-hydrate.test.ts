/**
 * Hydration: reuse the markup a server render leaves, or take the root over
 * when the client tree cannot be lined up with it.
 */
import { describe, expect, it } from "vitest";
import { REACT_SUSPENSE_TYPE, createElement, use, useState } from "../react.ts";
import type { Any } from "../shared.ts";
import { hydrateRoot } from "../react-dom-client.ts";
import { REVEAL_BOUNDARY } from "../react-dom-server.ts";
import { asElement, TestDocument, TestElement, TestNode, TestText } from "./dom-shim.ts";
import { until } from "./helpers.ts";

/** Fizz markers and boundaries are comments; the shim has no node for them. */
class TestComment extends TestNode {
  data: string;
  constructor(data: string) {
    super(8);
    this.data = data;
  }
}

const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "link", "meta"]);

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

function unescapeHtml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity]);
}

/** The smallest reader that can rebuild the server's output, markers included. */
function parseNodes(document: TestDocument, html: string): TestNode[] {
  const nodes: TestNode[] = [];
  const stack: TestNode[] = [];
  let index = 0;

  const append = (node: TestNode): void => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) nodes.push(node);
    else parent.appendChild(node);
  };

  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      append(new TestComment(html.slice(index + 4, end)));
      index = end + 3;
      continue;
    }

    if (html[index] === "<") {
      const end = html.indexOf(">", index + 1);
      const tag = html.slice(index + 1, end);
      index = end + 1;
      if (tag.startsWith("/")) {
        stack.pop();
        continue;
      }

      const name = (/^([a-zA-Z0-9-]+)/.exec(tag)?.[1] ?? "").toLowerCase();
      const element = document.createElement(name);
      const attribute = /([^\s=/]+)="([^"]*)"/g;
      let pair = attribute.exec(tag);
      while (pair !== null) {
        element.setAttribute(pair[1], unescapeHtml(pair[2]));
        pair = attribute.exec(tag);
      }

      append(element);
      if (!tag.endsWith("/") && !VOID_ELEMENTS.has(name)) stack.push(element);
      continue;
    }

    const next = html.indexOf("<", index);
    const end = next === -1 ? html.length : next;
    append(new TestText(unescapeHtml(html.slice(index, end))));
    index = end;
  }

  return nodes;
}

/** Fill a container with server markup, before anything has hydrated it. */
function serverDom(html: string) {
  const document = new TestDocument();
  const container = document.createElement("root");
  for (const node of parseNodes(document, html)) container.appendChild(node);
  return { document, container };
}

/** Fill a container with server markup, then hydrate it. */
function hydrateMarkup(html: string, element: Any) {
  const { container } = serverDom(html);
  const root = hydrateRoot(container as unknown as Element, element);
  return { container, root };
}

describe("hydration", () => {
  it("reuses the server's nodes and attaches the missing listeners", () => {
    const clicks: string[] = [];
    const element = createElement("div", {
      className: "box",
      children: [
        createElement("button", { onClick: () => clicks.push("click"), children: "go" }),
        "tail",
      ],
    });

    const { container } = hydrateMarkup('<div class="box"><button>go</button>tail</div>', element);
    const div = asElement(container.childNodes[0]);
    const button = asElement(div.childNodes[0]);

    button.dispatch("click", {});
    expect(clicks).toEqual(["click"]);
    expect(div.getAttribute("class")).toBe("box");
    expect(div.textContent).toBe("gotail");
  });

  it("keeps hook state working from the hydrated tree", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "count:" + count,
      });
    }

    const { container } = hydrateMarkup("<button>count:0</button>", createElement(Counter, {}));
    asElement(container.childNodes[0]).dispatch("click", {});
    expect(container.textContent).toBe("count:1");
  });

  it("matches a component's output inside its host wrapper", () => {
    function Inner() {
      return createElement("b", { children: "hi" });
    }

    const { container } = hydrateMarkup(
      "<section><b>hi</b></section>",
      createElement("section", { children: createElement(Inner, {}) }),
    );
    expect(container.textContent).toBe("hi");
    expect(asElement(asElement(container.childNodes[0]).childNodes[0]).tagName).toBe("b");
  });

  it("takes the root over when the markup does not match the tree", () => {
    const { container } = hydrateMarkup(
      "<span>server</span>",
      createElement("div", { children: "client" }),
    );
    expect(container.childNodes).toHaveLength(1);
    expect(asElement(container.childNodes[0]).tagName).toBe("div");
    expect(container.textContent).toBe("client");
  });

  it("takes the root over when a text node differs", () => {
    const { container } = hydrateMarkup(
      "<p>server</p>",
      createElement("p", { children: "client" }),
    );
    expect(container.textContent).toBe("client");
    expect(asElement(container.childNodes[0]).childNodes).toHaveLength(1);
  });

  it("requires a container that belongs to a document", () => {
    expect(() => hydrateRoot({ ownerDocument: null } as unknown as Element, "x")).toThrow(
      "createRoot() requires a container that belongs to a document.",
    );
  });
});

describe("hydrating Suspense", () => {
  it("reuses a completed boundary around its markers", () => {
    const element = createElement(REACT_SUSPENSE_TYPE, {
      fallback: createElement("p", { children: "loading" }),
      children: createElement("b", { children: "done" }),
    });

    const { container } = hydrateMarkup(
      "<div><!--$--><b>done</b><!--/$--></div>",
      createElement("div", { children: element }),
    );
    const div = asElement(container.childNodes[0]);

    expect(container.textContent).toBe("done");
    expect(div.childNodes).toHaveLength(3);
    expect((div.childNodes[0] as TestComment).data).toBe("$");
    expect((div.childNodes[2] as TestComment).data).toBe("/$");
    expect(asElement(div.childNodes[1]).tagName).toBe("b");
  });

  it("hydrates boundary content when the server wrote no markers", () => {
    const element = createElement(REACT_SUSPENSE_TYPE, {
      fallback: "loading",
      children: createElement("b", { children: "done" }),
    });

    const { container } = hydrateMarkup(
      "<div><b>done</b></div>",
      createElement("div", { children: element }),
    );
    expect(container.textContent).toBe("done");
    expect(container.childNodes).toHaveLength(1);
  });

  it("keeps a completed boundary on screen while its client render suspends", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));
    const clicks: string[] = [];

    function Show() {
      return createElement("b", { children: use(pending) });
    }
    const element = createElement(REACT_SUSPENSE_TYPE, {
      fallback: createElement("p", { children: "loading" }),
      children: [
        createElement("i", { onClick: () => clicks.push("click"), children: "one" }),
        createElement(Show, {}),
      ],
    });

    const { container } = hydrateMarkup(
      "<div><!--$--><i>one</i><b>done</b><!--/$--></div>",
      createElement("div", { children: element }),
    );
    const div = asElement(container.childNodes[0]);
    const icon = asElement(div.childNodes[1]);

    // A suspension is not a mismatch: the fallback never replaces the content.
    expect(div.textContent).toBe("onedone");
    expect(asElement(div.childNodes[1])).toBe(icon);
    expect(div.childNodes).toHaveLength(4);
    expect(icon.listeners.has("click")).toBe(false);

    settle("done");
    await until(() => icon.listeners.has("click"));

    // Hydrated in place after the data arrived: same nodes, a single listener.
    expect(asElement(div.childNodes[1])).toBe(icon);
    icon.dispatch("click", {});
    expect(clicks).toEqual(["click"]);
    expect(div.childNodes).toHaveLength(4);
  });

  it("leaves a pending boundary alone, then replaces only that boundary", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));
    const clicks: string[] = [];

    function Show() {
      return createElement("b", { children: use(pending) });
    }
    const element = createElement("div", {
      children: [
        createElement("button", { onClick: () => clicks.push("click"), children: "ok" }),
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: createElement("p", { children: "loading" }),
          children: createElement(Show, {}),
        }),
      ],
    });

    const { container } = hydrateMarkup(
      '<div><button>ok</button><!--$?--><template id="B0"></template><p>loading</p><!--/$--></div>',
      element,
    );
    const div = asElement(container.childNodes[0]);
    const button = asElement(div.childNodes[0]);

    expect(container.textContent).toBe("okloading");
    // The deferred boundary keeps the placeholder and fallback the server sent.
    expect(asElement(div.childNodes[2]).tagName).toBe("template");
    expect(asElement(div.childNodes[3]).tagName).toBe("p");

    settle("done");
    await until(() => container.textContent === "okdone");

    // The sibling was never re-rendered: same node, working listener.
    expect(asElement(div.childNodes[0])).toBe(button);
    button.dispatch("click", {});
    expect(clicks).toEqual(["click"]);

    // Only the boundary's range changed; its markers stay in place.
    expect(div.childNodes).toHaveLength(4);
    expect((div.childNodes[1] as TestComment).data).toBe("$?");
    expect(asElement(div.childNodes[2]).tagName).toBe("b");
    expect((div.childNodes[3] as TestComment).data).toBe("/$");
  });

  it("keeps a pending boundary when an unrelated state update runs first", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));

    function Show() {
      return createElement("b", { children: use(pending) });
    }
    function Shell() {
      const [count, setCount] = useState(0);
      return createElement("div", {
        children: [
          createElement("button", {
            onClick: () => setCount(count + 1),
            children: "count:" + count,
          }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: createElement("p", { children: "loading" }),
            children: createElement(Show, {}),
          }),
        ],
      });
    }

    const { container } = hydrateMarkup(
      '<div><button>count:0</button><!--$?--><template id="B0"></template><p>loading</p><!--/$--></div>',
      createElement(Shell, {}),
    );
    const div = asElement(container.childNodes[0]);

    // The update runs while the boundary is still waiting on its data.
    asElement(div.childNodes[0]).dispatch("click", {});
    expect(container.textContent).toBe("count:1loading");

    // The boundary was still pending, so its settlement must still be honoured.
    settle("done");
    await until(() => container.textContent === "count:1done");
  });

  it("retries every boundary that waits on the same thenable", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));

    function Show({ label }: { label: string }) {
      return createElement("b", { children: label + use(pending) });
    }
    const boundary = (label: string) =>
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: createElement("p", { children: "loading" }),
        children: createElement(Show, { label }),
      });

    const { container } = hydrateMarkup(
      '<div><!--$?--><template id="B0"></template><p>loading</p><!--/$-->' +
        '<!--$?--><template id="B1"></template><p>loading</p><!--/$--></div>',
      createElement("div", { children: [boundary("a:"), boundary("b:")] }),
    );
    expect(container.textContent).toBe("loadingloading");

    // One settlement has to release both boundaries: each keeps its own retry.
    settle("1");
    await until(() => container.textContent === "a:1b:1");
  });

  it("defers a retry that settles while the walk is still hydrating", () => {
    // A synchronous thenable is the worst case: without deferral the retry
    // would replace the boundary while the pass is still claiming its nodes.
    const immediate: Any = {
      then(resolve: (value: string) => void) {
        resolve("done");
      },
    };

    function Show() {
      return createElement("b", { children: use(immediate) });
    }
    const element = createElement(REACT_SUSPENSE_TYPE, {
      fallback: createElement("p", { children: "loading" }),
      children: createElement(Show, {}),
    });

    const { container } = hydrateMarkup(
      '<div><!--$?--><template id="B0"></template><p>loading</p><!--/$--></div>',
      createElement("div", { children: element }),
    );
    const div = asElement(container.childNodes[0]);

    expect(div.textContent).toBe("done");
    expect(asElement(div.childNodes[1]).tagName).toBe("b");
  });

  it("client renders a boundary the server gave up on", () => {
    const element = createElement(REACT_SUSPENSE_TYPE, {
      fallback: createElement("p", { children: "failed" }),
      children: createElement("b", { children: "client" }),
    });

    const { container } = hydrateMarkup(
      '<div><!--$!--><template id="B0" data-dgst="" data-msg="boom"></template><p>failed</p><!--/$--></div>',
      createElement("div", { children: element }),
    );
    // React retries the boundary on the client instead of keeping the fallback.
    expect(container.textContent).toBe("client");
  });

  it("client renders only the boundary whose content no longer matches", () => {
    const element = createElement("div", {
      children: [
        createElement("i", { children: "keep" }),
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading",
          children: createElement("b", { children: "client" }),
        }),
      ],
    });

    const { container } = serverDom("<div><i>keep</i><!--$--><b>server</b><!--/$--></div>");
    const div = asElement(container.childNodes[0]);
    const keep = asElement(div.childNodes[0]);

    hydrateRoot(container as unknown as Element, element);

    expect(asElement(div.childNodes[0])).toBe(keep);
    expect(div.textContent).toBe("keepclient");
    expect(div.childNodes).toHaveLength(4);
    expect(asElement(div.childNodes[2]).tagName).toBe("b");
  });
});

/** The node whose `id` the reveal script looks up, or `null` once it is gone. */
function findById(node: TestNode, id: string): TestNode | null {
  if (node instanceof TestElement && node.attributes.get("id") === id) return node;
  for (const child of node.childNodes) {
    const found = findById(child, id);
    if (found !== null) return found;
  }
  return null;
}

/** Run the script a boundary chunk carries, with the globals it expects. */
function runReveal(root: TestNode, boundaryId: string, contentId: string): void {
  const globals = globalThis as Any;
  const previousDocument = globals.document;
  const previousNode = globals.Node;
  globals.document = { getElementById: (id: string) => findById(root, id) };
  globals.Node = { COMMENT_NODE: 8 };
  try {
    const reveal = new Function("return (" + REVEAL_BOUNDARY + ")")() as (
      boundaryId: string,
      contentId: string,
    ) => void;
    reveal(boundaryId, contentId);
  } finally {
    globals.document = previousDocument;
    globals.Node = previousNode;
  }
}

const POSTPONED_SHELL = '<div><!--$?--><template id="B0"></template><p>loading</p><!--/$--></div>';
const STREAMED_CONTENT = '<div hidden id="S0"><b>done</b></div>';

describe("a streamed boundary", () => {
  it("moves the content the server sent into the boundary", () => {
    const { document, container } = serverDom(POSTPONED_SHELL);
    const div = asElement(container.childNodes[0]);
    for (const node of parseNodes(document, STREAMED_CONTENT)) container.appendChild(node);

    runReveal(container, "B0", "S0");

    expect(div.textContent).toBe("done");
    expect((div.childNodes[0] as TestComment).data).toBe("$");
    expect(findById(container, "B0")).toBeNull();
    // The copy only held the content; it must not survive the splice.
    expect(findById(container, "S0")).toBeNull();
  });

  it("drops the copy when the client already rendered the boundary", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (release = resolve));

    function Show() {
      return createElement("b", { children: use(pending) });
    }
    const element = createElement("div", {
      children: createElement(REACT_SUSPENSE_TYPE, {
        fallback: createElement("p", { children: "loading" }),
        children: createElement(Show, {}),
      }),
    });

    const { document, container } = serverDom(POSTPONED_SHELL);
    hydrateRoot(container as unknown as Element, element);
    const div = asElement(container.childNodes[0]);

    // The client's data wins the race: the boundary is client rendered, and the
    // server's template and fallback are gone.
    release("done");
    await until(() => div.textContent === "done");
    expect(findById(container, "B0")).toBeNull();

    // The server's chunk arrives afterwards, when there is nothing left to fill.
    for (const node of parseNodes(document, STREAMED_CONTENT)) container.appendChild(node);
    runReveal(container, "B0", "S0");

    expect(findById(container, "S0")).toBeNull();
    expect(div.textContent).toBe("done");
  });
});
