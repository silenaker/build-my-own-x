/**
 * Client behavior: mounting, re-rendering and Suspense retries against the DOM
 * host. Server-side string output lives in `render-to-string.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  REACT_FRAGMENT_TYPE,
  REACT_SUSPENSE_TYPE,
  createElement,
  lazy,
  use,
  useRef,
  useState,
} from "../react.ts";
import type { Any } from "../shared.ts";
import { createRoot, hydrateRoot } from "../react-dom-client.ts";
import { asElement, mount, TestDocument, TestText } from "./dom-shim.ts";
import { until } from "./helpers.ts";

describe("suspense", () => {
  const never = new Promise<never>(() => {});

  /** Throws the same pending thenable on every read. */
  function Suspends() {
    use(never);
    return createElement("b", { children: "unreachable" });
  }

  it("shows the fallback, then the content once the thenable settles", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));

    function Child() {
      return createElement("b", { children: use(pending) });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: createElement("p", { children: "loading" }),
        children: createElement(Child, {}),
      }),
    );
    expect(container.textContent).toBe("loading");

    settle("ready");
    await until(() => container.textContent === "ready");
    expect(asElement(container.childNodes[0]).tagName).toBe("b");
  });

  it("never commits the partial content of a suspended boundary", () => {
    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement("div", {
          children: ["partial", createElement(Suspends, {})],
        }),
      }),
    );
    expect(container.childNodes).toHaveLength(1);
    expect(container.textContent).toBe("loading");
  });

  it("retries sibling boundaries independently and keeps their order", async () => {
    let settleA!: (value: string) => void;
    let settleB!: (value: string) => void;
    const a = new Promise<string>((resolve) => (settleA = resolve));
    const b = new Promise<string>((resolve) => (settleB = resolve));

    function Show({ value, label }: { value: Promise<string>; label: string }) {
      return createElement("b", { children: label + use(value) });
    }

    const container = mount(
      createElement("div", {
        children: [
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "wait-a",
            children: createElement(Show, { value: a, label: "a:" }),
          }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "wait-b",
            children: createElement(Show, { value: b, label: "b:" }),
          }),
        ],
      }),
    );
    expect(container.textContent).toBe("wait-await-b");

    settleA("1");
    await until(() => container.textContent === "a:1wait-b");

    settleB("2");
    await until(() => container.textContent === "a:1b:2");
  });

  it("waits for a lazy component and renders it once loaded", async () => {
    let settle!: (exports: { default: Any }) => void;
    const loaded = new Promise<{ default: Any }>((resolve) => (settle = resolve));
    const Widget = lazy(() => loaded);

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(Widget, {}),
      }),
    );
    expect(container.textContent).toBe("loading");

    settle({ default: () => createElement("b", { children: "lazy" }) });
    await until(() => container.textContent === "lazy");
    expect(asElement(container.childNodes[0]).tagName).toBe("b");
  });

  it("keeps a mounted component's state while an update suspends", async () => {
    let pending: Promise<void> | null = null;
    let settle!: () => void;
    let suspend = false;

    function Child() {
      const [count, setCount] = useState(0);
      if (suspend) {
        const wait = (pending ??= new Promise<void>((resolve) => (settle = resolve)));
        use(wait);
      }
      return createElement("button", {
        onClick: () => {
          suspend = true;
          setCount(count + 1);
        },
        children: "count:" + count,
      });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: createElement("p", { children: "loading" }),
        children: createElement(Child, {}),
      }),
    );
    expect(container.textContent).toBe("count:0");

    asElement(container.childNodes[0]).dispatch("click", {});
    expect(container.textContent).toBe("loading");

    settle();
    await until(() => container.textContent === "count:1");
  });

  it("keeps the state of content the suspended attempt never reached", async () => {
    let settle!: () => void;
    let pending: Promise<void> | null = null;
    let suspend = false;

    function Slow() {
      if (suspend) {
        const wait = (pending ??= new Promise<void>((resolve) => (settle = resolve)));
        use(wait);
      }
      return null;
    }

    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("span", {
        onClick: () => setCount(count + 1),
        children: "count:" + count,
      });
    }

    function App() {
      const [, setArmed] = useState(false);
      return createElement("div", {
        children: [
          createElement("button", {
            onClick: () => {
              suspend = true;
              setArmed(true);
            },
            children: "arm",
          }),
          createElement(Slow, {}),
          createElement(Counter, {}),
        ],
      });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(App, {}),
      }),
    );
    const div = () => asElement(container.childNodes[0]);
    const arm = () => asElement(div().childNodes[0]);
    const counter = () => asElement(div().childNodes[1]);

    counter().dispatch("click", {});
    counter().dispatch("click", {});
    expect(container.textContent).toBe("armcount:2");

    // Slow suspends before Counter is reached, so this pass never touches it.
    arm().dispatch("click", {});
    expect(container.textContent).toBe("loading");

    settle();
    await until(() => container.textContent === "armcount:2");
  });
});

describe("component identity", () => {
  /** A counter whose state belongs to one position in the tree. */
  function Counter({ label }: { label: string }) {
    const [count, setCount] = useState(0);
    return createElement("button", {
      onClick: () => setCount(count + 1),
      children: label + count,
    });
  }

  function mountRoot(element: Any) {
    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);
    root.render(element);
    return { container, root };
  }

  const click = (node: Any): void => asElement(node).dispatch("click", {});

  it("mounts fresh when another component takes the same position", () => {
    function A() {
      const [count, setCount] = useState(0);
      return createElement("b", {
        onClick: () => setCount(count + 1),
        children: "a" + count,
      });
    }
    function B() {
      const [count] = useState(9);
      return createElement("b", { children: "b" + count });
    }

    const { container, root } = mountRoot(createElement(A, {}));
    click(container.childNodes[0]);
    expect(container.textContent).toBe("a1");

    root.render(createElement(B, {}));
    expect(container.textContent).toBe("b9");
  });

  it("does not hand a hook slot to a different kind of hook", () => {
    function UsesRef() {
      useRef(0);
      return createElement("b", { children: "ref" });
    }
    function UsesState() {
      const [value] = useState("fresh");
      return createElement("b", { children: value });
    }

    const { container, root } = mountRoot(createElement(UsesRef, {}));
    expect(container.textContent).toBe("ref");

    root.render(createElement(UsesState, {}));
    expect(container.textContent).toBe("fresh");
  });

  it("remounts the subtree when an ancestor host element changes type", () => {
    const { container, root } = mountRoot(
      createElement("div", { children: createElement(Counter, { label: "n" }) }),
    );
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("n1");

    root.render(createElement("section", { children: createElement(Counter, { label: "n" }) }));
    expect(asElement(container.childNodes[0]).tagName).toBe("section");
    expect(container.textContent).toBe("n0");
  });

  it("remounts when the component moves to another parent", () => {
    const { container, root } = mountRoot(
      createElement("div", { children: createElement(Counter, { label: "n" }) }),
    );
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("n1");

    root.render(
      createElement("div", {
        children: [createElement("span", {}), createElement(Counter, { label: "n" })],
      }),
    );
    expect(container.textContent).toBe("n0");
  });

  it("keeps state with the key when keyed children reorder", () => {
    const { container, root } = mountRoot(
      createElement("div", {
        children: [
          createElement(Counter, { label: "x" }, "x"),
          createElement(Counter, { label: "y" }, "y"),
        ],
      }),
    );
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("x1y0");

    root.render(
      createElement("div", {
        children: [
          createElement(Counter, { label: "y" }, "y"),
          createElement(Counter, { label: "x" }, "x"),
        ],
      }),
    );
    expect(container.textContent).toBe("y0x1");
  });

  it("follows position for unkeyed siblings", () => {
    const { container, root } = mountRoot(
      createElement("div", {
        children: [createElement(Counter, { label: "x" }), createElement(Counter, { label: "y" })],
      }),
    );
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("x1y0");

    root.render(
      createElement("div", {
        children: [createElement(Counter, { label: "y" }), createElement(Counter, { label: "x" })],
      }),
    );
    // Without keys the state belongs to the slot, not to the label.
    expect(container.textContent).toBe("y1x0");
  });

  it("keeps a keyed host subtree with its key when it moves", () => {
    const box = (key: string) =>
      createElement("div", { children: createElement(Counter, { label: "n" }) }, key);

    const { container, root } = mountRoot(
      createElement("section", { children: [box("a"), box("b")] }),
    );
    click(asElement(asElement(container.childNodes[0]).childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("n1n0");

    root.render(createElement("section", { children: [box("b"), box("a")] }));
    expect(container.textContent).toBe("n0n1");
  });

  it("keeps boundary content with its key when boundaries reorder", () => {
    const boundary = (key: string, label: string) =>
      createElement(
        REACT_SUSPENSE_TYPE,
        { fallback: "wait", children: createElement(Counter, { label }) },
        key,
      );

    const { container, root } = mountRoot(
      createElement("div", { children: [boundary("a", "a"), boundary("b", "b")] }),
    );
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("a1b0");

    root.render(createElement("div", { children: [boundary("b", "b"), boundary("a", "a")] }));
    expect(container.textContent).toBe("b0a1");
  });
});

describe("targeted updates", () => {
  function mountRoot(element: Any) {
    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);
    root.render(element);
    return { container, root };
  }

  const click = (node: Any): void => asElement(node).dispatch("click", {});

  it("re-renders only the component whose state changed", () => {
    const calls = { app: 0, counter: 0, sibling: 0 };

    function Counter() {
      calls.counter++;
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "c" + count,
      });
    }
    function Sibling() {
      calls.sibling++;
      return createElement("span", { children: "s" });
    }
    function App() {
      calls.app++;
      return createElement("div", {
        children: [createElement(Counter, {}), createElement(Sibling, {})],
      });
    }

    const { container } = mountRoot(createElement(App, {}));
    expect(calls).toEqual({ app: 1, counter: 1, sibling: 1 });

    click(asElement(container.childNodes[0]).childNodes[0]);

    expect(calls).toEqual({ app: 1, counter: 2, sibling: 1 });
    expect(container.textContent).toBe("c1s");
  });

  it("keeps a growing component's siblings in order", () => {
    function Grow() {
      const [count, setCount] = useState(1);
      const items = [];
      for (let i = 0; i < count; i++) items.push(createElement("i", { children: String(i) }));
      return createElement("span", { onClick: () => setCount(count + 1), children: items });
    }
    function Other() {
      const [count, setCount] = useState(0);
      return createElement("b", { onClick: () => setCount(count + 1), children: "o" + count });
    }

    const { container } = mountRoot(
      createElement("div", { children: [createElement(Grow, {}), createElement(Other, {})] }),
    );
    const div = asElement(container.childNodes[0]);

    click(div.childNodes[0]);
    click(div.childNodes[0]);
    expect(div.textContent).toBe("012o0");
    expect(asElement(div.childNodes[0]).childNodes).toHaveLength(3);

    click(div.childNodes[1]);
    expect(div.childNodes).toHaveLength(2);
    expect(div.textContent).toBe("012o1");
  });

  it("targets the keyed component after its siblings move", () => {
    function Counter({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: label + count,
      });
    }
    const counter = (key: string) => createElement(Counter, { label: key }, key);

    const { container, root } = mountRoot(
      createElement("div", { children: [counter("x"), counter("y")] }),
    );
    const div = () => asElement(container.childNodes[0]);

    click(div().childNodes[0]);
    expect(container.textContent).toBe("x1y0");

    root.render(createElement("div", { children: [counter("y"), counter("x")] }));
    expect(container.textContent).toBe("y0x1");

    click(div().childNodes[0]);
    expect(container.textContent).toBe("y1x1");
  });

  it("prunes output a targeted component stops emitting", () => {
    function Shrink() {
      const [count, setCount] = useState(3);
      const items = [];
      for (let i = 0; i < count; i++) items.push(createElement("i", { children: String(i) }));
      return createElement("span", { onClick: () => setCount(0), children: items });
    }
    function Other() {
      const [count, setCount] = useState(0);
      return createElement("b", { onClick: () => setCount(count + 1), children: "o" + count });
    }

    const { container } = mountRoot(
      createElement("div", { children: [createElement(Shrink, {}), createElement(Other, {})] }),
    );
    const div = asElement(container.childNodes[0]);
    expect(div.textContent).toBe("012o0");

    click(div.childNodes[0]);
    expect(div.textContent).toBe("o0");
    expect(asElement(div.childNodes[0]).childNodes).toHaveLength(0);

    click(div.childNodes[1]);
    expect(div.childNodes).toHaveLength(2);
    expect(div.textContent).toBe("o1");
  });

  it("updates sibling components independently", () => {
    const calls = { a: 0, b: 0 };

    function A() {
      calls.a++;
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "a" + count,
      });
    }
    function B() {
      calls.b++;
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "b" + count,
      });
    }

    const { container } = mountRoot(
      createElement("div", { children: [createElement(A, {}), createElement(B, {})] }),
    );
    const div = asElement(container.childNodes[0]);

    click(div.childNodes[0]);
    expect(calls).toEqual({ a: 2, b: 1 });
    expect(div.textContent).toBe("a1b0");

    click(div.childNodes[1]);
    expect(calls).toEqual({ a: 2, b: 2 });
    expect(div.textContent).toBe("a1b1");
  });
});

describe("DOM target", () => {
  it("mounts a host tree", () => {
    const container = mount(
      createElement("div", { children: createElement("span", { children: "hi" }) }),
    );
    expect(container.childNodes).toHaveLength(1);
    const div = asElement(container.childNodes[0]);
    expect(div.tagName).toBe("div");
    const span = asElement(div.childNodes[0]);
    expect(span.tagName).toBe("span");
    expect((span.childNodes[0] as TestText).data).toBe("hi");
  });

  it("applies attributes, aliases and style", () => {
    const container = mount(
      createElement("div", { className: "a", id: "b", style: { color: "red", marginTop: 4 } }),
    );
    const div = asElement(container.childNodes[0]);
    expect(div.getAttribute("class")).toBe("a");
    expect(div.getAttribute("id")).toBe("b");
    expect(div.getAttribute("style")).toBe("color:red;margin-top:4px");
  });

  it("attaches event listeners", () => {
    const clicks: string[] = [];
    const container = mount(
      createElement("button", { onClick: () => clicks.push("click"), children: "go" }),
    );
    asElement(container.childNodes[0]).dispatch("click", {});
    expect(clicks).toEqual(["click"]);
  });

  it("honours dangerouslySetInnerHTML", () => {
    const container = mount(
      createElement("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }),
    );
    const div = asElement(container.childNodes[0]);
    expect(div.innerHTML).toBe("<b>raw</b>");
    expect(div.childNodes).toHaveLength(0);
  });

  it("replaces the tree on re-render and clears it on unmount", () => {
    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);

    root.render(createElement("div", { children: "one" }));
    expect(container.textContent).toBe("one");

    root.render(createElement("p", { children: "two" }));
    expect(container.childNodes).toHaveLength(1);
    expect(container.textContent).toBe("two");

    root.unmount();
    expect(container.childNodes).toHaveLength(0);
  });

  it("renders fragments, arrays and components", () => {
    const List = () => [
      createElement("li", { children: "a" }),
      createElement("li", { children: "b" }),
    ];
    const container = mount(
      createElement(REACT_FRAGMENT_TYPE, {
        children: [createElement("i", { children: "1" }), createElement(List, {})],
      }),
    );
    expect(container.textContent).toBe("1ab");
    expect(container.childNodes).toHaveLength(3);
  });

  it("requires a container that belongs to a document", () => {
    expect(() => createRoot({ ownerDocument: null } as unknown as Element)).toThrow(
      "createRoot() requires a container that belongs to a document.",
    );
  });
});

describe("patching", () => {
  function mountRoot(element: Any) {
    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);
    root.render(element);
    return { container, root };
  }

  it("keeps the nodes a re-render did not change", () => {
    const { container, root } = mountRoot(
      createElement("div", { className: "a", children: createElement("b", { children: "one" }) }),
    );
    const div = asElement(container.childNodes[0]);
    const bold = asElement(div.childNodes[0]);
    const text = bold.childNodes[0];

    root.render(
      createElement("div", { className: "b", children: createElement("b", { children: "two" }) }),
    );

    expect(container.childNodes[0]).toBe(div);
    expect(div.childNodes[0]).toBe(bold);
    expect(bold.childNodes[0]).toBe(text);
    expect(div.getAttribute("class")).toBe("b");
    expect((text as TestText).data).toBe("two");
  });

  it("drops the attributes and children the new element left out", () => {
    const { container, root } = mountRoot(
      createElement("div", {
        id: "x",
        title: "t",
        children: [createElement("i", { children: "a" }), createElement("i", { children: "b" })],
      }),
    );
    const div = asElement(container.childNodes[0]);
    const first = div.childNodes[0];

    root.render(createElement("div", { id: "x", children: createElement("i", { children: "a" }) }));

    expect(div.getAttribute("id")).toBe("x");
    expect(div.getAttribute("title")).toBeNull();
    expect(div.childNodes).toHaveLength(1);
    expect(div.childNodes[0]).toBe(first);
    expect(container.textContent).toBe("a");
  });

  it("replaces a changed listener instead of adding another", () => {
    const calls: string[] = [];
    const button = (handler: () => void) =>
      createElement("button", { onClick: handler, children: "go" });

    const { container, root } = mountRoot(button(() => calls.push("old")));
    const node = asElement(container.childNodes[0]);

    root.render(button(() => calls.push("new")));
    node.dispatch("click", {});

    expect(node.listeners.get("click")).toHaveLength(1);
    expect(calls).toEqual(["new"]);
  });

  it("moves keyed siblings instead of recreating them", () => {
    const box = (key: string) => createElement("div", { children: key }, key);

    const { container, root } = mountRoot(
      createElement("section", { children: [box("a"), box("b")] }),
    );
    const section = asElement(container.childNodes[0]);
    const first = section.childNodes[0];
    const second = section.childNodes[1];

    root.render(createElement("section", { children: [box("b"), box("a")] }));

    expect(section.childNodes[0]).toBe(second);
    expect(section.childNodes[1]).toBe(first);
  });

  it("rewrites innerHTML only when it changes", () => {
    const { container, root } = mountRoot(
      createElement("div", { dangerouslySetInnerHTML: { __html: "<b>one</b>" } }),
    );
    const div = asElement(container.childNodes[0]);

    root.render(createElement("div", { dangerouslySetInnerHTML: { __html: "<b>two</b>" } }));

    expect(container.childNodes[0]).toBe(div);
    expect(div.innerHTML).toBe("<b>two</b>");
  });

  it("patches a state update in place", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "count:" + count,
      });
    }

    const { container } = mountRoot(createElement(Counter, {}));
    const button = asElement(container.childNodes[0]);
    const text = button.childNodes[0];

    button.dispatch("click", {});

    expect(container.childNodes[0]).toBe(button);
    expect(button.childNodes[0]).toBe(text);
    expect((text as TestText).data).toBe("count:1");
  });

  it("patches the tree a hydration adopted", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "count:" + count,
      });
    }

    const document = new TestDocument();
    const container = document.createElement("root");
    const server = document.createElement("button");
    server.appendChild(document.createTextNode("count:0"));
    container.appendChild(server);
    hydrateRoot(container as unknown as Element, createElement(Counter, {}));

    asElement(server).dispatch("click", {});

    expect(container.childNodes[0]).toBe(server);
    expect(server.textContent).toBe("count:1");
  });
});
