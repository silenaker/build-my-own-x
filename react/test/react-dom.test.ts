import { describe, expect, it } from "vitest";
import {
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_SUSPENSE_TYPE,
  createElement,
  lazy,
  use,
  useRef,
  useState,
} from "../react.ts";
import type { Any } from "../shared.ts";
import { createRoot, renderToString } from "../react-dom.ts";
import { asElement, mount, TestDocument, TestText } from "./dom-shim.ts";
import { deepAwait } from "../react-flight-client.ts";
import { until } from "./helpers.ts";

describe("leaves", () => {
  it("renders nothing for null, undefined and booleans", () => {
    expect(renderToString(null)).toBe("");
    expect(renderToString(undefined)).toBe("");
    expect(renderToString(false)).toBe("");
    expect(renderToString(true)).toBe("");
  });

  it("renders strings, numbers and bigints as text", () => {
    expect(renderToString("hi")).toBe("hi");
    expect(renderToString(42)).toBe("42");
    expect(renderToString(0)).toBe("0");
    expect(renderToString(-0)).toBe("0");
    expect(renderToString(10n)).toBe("10");
    expect(renderToString(["a", 1, null, false, "b"])).toBe("a1b");
  });

  it("escapes text children", () => {
    expect(renderToString('<b>&"\'')).toBe("&lt;b&gt;&amp;&quot;&#x27;");
  });
});

describe("host elements", () => {
  it("renders simple and nested trees", () => {
    expect(renderToString(createElement("div", { children: "hi" }))).toBe("<div>hi</div>");
    expect(
      renderToString(
        createElement("div", {
          children: [
            createElement("span", { children: "a" }),
            createElement("b", { children: "b" }),
          ],
        }),
      ),
    ).toBe("<div><span>a</span><b>b</b></div>");
  });

  it("renders empty and void elements", () => {
    expect(renderToString(createElement("div", {}))).toBe("<div></div>");
    expect(renderToString(createElement("br", {}))).toBe("<br/>");
    expect(renderToString(createElement("hr", {}))).toBe("<hr/>");
    expect(renderToString(createElement("img", { src: "a.png", alt: "" }))).toBe(
      '<img src="a.png" alt=""/>',
    );
    expect(renderToString(createElement("input", { type: "text", value: "v" }))).toBe(
      '<input type="text" value="v"/>',
    );
  });

  it("maps prop aliases and keeps data/aria attributes", () => {
    expect(
      renderToString(
        createElement("label", {
          htmlFor: "x",
          className: "a b",
          id: "x",
          "data-role": "btn",
          "aria-hidden": "true",
        }),
      ),
    ).toBe('<label for="x" class="a b" id="x" data-role="btn" aria-hidden="true"></label>');
  });

  it("handles boolean and default attributes", () => {
    expect(
      renderToString(createElement("button", { disabled: true, hidden: false, children: "go" })),
    ).toBe('<button disabled="">go</button>');
    expect(renderToString(createElement("input", { readOnly: true }))).toBe(
      '<input readOnly=""/>',
    );
    expect(renderToString(createElement("input", { defaultValue: "d" }))).toBe(
      '<input value="d"/>',
    );
    expect(renderToString(createElement("input", { defaultChecked: true }))).toBe(
      '<input checked=""/>',
    );
    expect(renderToString(createElement("div", { draggable: true }))).toBe(
      '<div draggable="true"></div>',
    );
    expect(renderToString(createElement("div", { draggable: false }))).toBe(
      '<div draggable="false"></div>',
    );
  });

  it("escapes attribute values", () => {
    expect(renderToString(createElement("div", { title: 'a"b&c' }))).toBe(
      '<div title="a&quot;b&amp;c"></div>',
    );
  });

  it("skips props that are not attributes", () => {
    expect(
      renderToString(
        createElement("div", {
          children: "x",
          key: "k",
          ref: () => {},
          onClick: () => {},
          ignored: { nested: true },
          alsoIgnored: Symbol("s"),
        }),
      ),
    ).toBe("<div>x</div>");
  });

  it("renders unknown host tags", () => {
    expect(renderToString(createElement("my-element", { children: "x" }))).toBe(
      "<my-element>x</my-element>",
    );
  });
});

describe("style", () => {
  it("converts a style object to inline CSS with units", () => {
    expect(
      renderToString(
        createElement("div", {
          style: {
            color: "red",
            marginTop: 5,
            opacity: 0.5,
            lineHeight: 1.5,
            zIndex: 2,
            margin: 0,
          },
        }),
      ),
    ).toBe(
      '<div style="color:red;margin-top:5px;opacity:0.5;line-height:1.5;z-index:2;margin:0"></div>',
    );
  });

  it("keeps a style string verbatim", () => {
    expect(renderToString(createElement("div", { style: "color:red" }))).toBe(
      '<div style="color:red"></div>',
    );
  });

  it("omits empty styles and unitless vendor properties", () => {
    expect(renderToString(createElement("div", { style: { color: null } }))).toBe("<div></div>");
    expect(renderToString(createElement("div", { style: { WebkitLineClamp: 2 } }))).toBe(
      '<div style="-webkit-line-clamp:2"></div>',
    );
  });
});

describe("dangerouslySetInnerHTML", () => {
  it("renders raw HTML and ignores children", () => {
    expect(
      renderToString(
        createElement("div", {
          dangerouslySetInnerHTML: { __html: "<b>raw &amp; bold</b>" },
          children: "ignored",
        }),
      ),
    ).toBe("<div><b>raw &amp; bold</b></div>");
  });

  it("renders an empty raw HTML string", () => {
    expect(
      renderToString(createElement("div", { dangerouslySetInnerHTML: { __html: "" } })),
    ).toBe("<div></div>");
  });
});

describe("elements", () => {
  it("ignores event handlers in HTML", () => {
    expect(renderToString(createElement("button", { onClick: () => {}, children: "x" }))).toBe(
      "<button>x</button>",
    );
  });

  it("ignores keys", () => {
    expect(renderToString(createElement("li", { children: "a" }, "k1"))).toBe("<li>a</li>");
  });

  it("renders fragments and suspense children, not the fallback", () => {
    expect(
      renderToString(
        createElement(REACT_FRAGMENT_TYPE, {
          children: [
            createElement("a", { children: "1" }),
            createElement("b", { children: "2" }),
          ],
        }),
      ),
    ).toBe("<a>1</a><b>2</b>");
    expect(
      renderToString(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: createElement("p", { children: "loading" }),
          children: createElement("div", { children: "done" }),
        }),
      ),
    ).toBe("<div>done</div>");
  });

  it("renders function components and their return shapes", () => {
    const Greeting = (props: { name: string }) =>
      createElement("h1", { children: "Hello " + props.name });
    expect(renderToString(createElement(Greeting, { name: "RSC" }))).toBe("<h1>Hello RSC</h1>");

    const List = () => [
      createElement("li", { children: "a" }),
      createElement("li", { children: "b" }),
    ];
    expect(renderToString(createElement("ul", { children: createElement(List, {}) }))).toBe(
      "<ul><li>a</li><li>b</li></ul>",
    );

    const Nothing = () => null;
    expect(renderToString(createElement("div", { children: createElement(Nothing, {}) }))).toBe(
      "<div></div>",
    );

    function Inner() {
      return createElement("b", { children: "nested" });
    }
    const Outer = () => createElement(Inner, {});
    expect(renderToString(createElement(Outer, {}))).toBe("<b>nested</b>");
  });
});

describe("lazy", () => {
  it("renders a lazy child and a lazy element type", () => {
    const lazyChild = {
      $$typeof: REACT_LAZY_TYPE,
      _init: () => createElement("em", { children: "lazy" }),
    };
    expect(renderToString(createElement("div", { children: lazyChild }))).toBe(
      "<div><em>lazy</em></div>",
    );

    const lazyComponent = {
      $$typeof: REACT_LAZY_TYPE,
      _init: () => (props: Any) => createElement("u", { children: props.label }),
    };
    expect(renderToString(createElement(lazyComponent, { label: "u" }))).toBe("<u>u</u>");
  });

  it("explains how to fix a lazy type that suspends synchronously", () => {
    const suspending = {
      $$typeof: REACT_LAZY_TYPE,
      _init() {
        throw { then() {} };
      },
    };
    expect(() => renderToString(createElement(suspending, {}))).toThrow(
      "suspended while rendering synchronously",
    );
  });

  it("loads React.lazy's default export once and caches it", async () => {
    let loads = 0;
    const Widget = lazy(() => {
      loads++;
      return Promise.resolve({
        default: (props: Any) => createElement("b", { children: props.label }),
      });
    });
    // The first read suspends on the loader; `deepAwait` waits and reads again.
    const tree = await deepAwait(
      createElement("div", { children: createElement(Widget, { label: "hi" }) }),
    );
    expect(renderToString(tree)).toBe("<div><b>hi</b></div>");
    expect(loads).toBe(1);

    renderToString(tree);
    expect(loads).toBe(1);
  });
});

describe("suspense", () => {
  const never = new Promise<never>(() => {});

  /** Throws the same pending thenable on every read. */
  function Suspends() {
    use(never);
    return createElement("b", { children: "unreachable" });
  }

  it("renders the fallback instead of the suspended children", () => {
    expect(
      renderToString(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: createElement("p", { children: "loading" }),
          children: createElement(Suspends, {}),
        }),
      ),
    ).toBe("<p>loading</p>");
  });

  it("drops the output produced before the suspension", () => {
    expect(
      renderToString(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading",
          children: createElement("div", {
            children: [
              createElement("span", { children: "partial" }),
              createElement(Suspends, {}),
            ],
          }),
        }),
      ),
    ).toBe("loading");
  });

  it("lets the nearest boundary handle the suspension", () => {
    expect(
      renderToString(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "outer",
          children: createElement(REACT_SUSPENSE_TYPE, {
            fallback: "inner",
            children: createElement(Suspends, {}),
          }),
        }),
      ),
    ).toBe("inner");
  });

  it("keeps a ready sibling of a suspended boundary", () => {
    expect(
      renderToString(
        createElement("div", {
          children: [
            createElement("span", { children: "ready" }),
            createElement(REACT_SUSPENSE_TYPE, {
              fallback: "wait",
              children: createElement(Suspends, {}),
            }),
          ],
        }),
      ),
    ).toBe("<div><span>ready</span>wait</div>");
  });

  it("explains a suspension with no boundary", () => {
    expect(() => renderToString(createElement(Suspends, {}))).toThrow("no <Suspense> boundary");
  });

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

    root.render(
      createElement("section", { children: createElement(Counter, { label: "n" }) }),
    );
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
        children: [
          createElement(Counter, { label: "x" }),
          createElement(Counter, { label: "y" }),
        ],
      }),
    );
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("x1y0");

    root.render(
      createElement("div", {
        children: [
          createElement(Counter, { label: "y" }),
          createElement(Counter, { label: "x" }),
        ],
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

describe("invalid input", () => {
  it("throws for invalid element types", () => {
    expect(() => renderToString(createElement(42, {}))).toThrow("Element type is invalid");
    expect(() => renderToString(createElement({}, {}))).toThrow("Element type is invalid");
  });

  it("throws for invalid children", () => {
    expect(() => renderToString(createElement("div", { children: { a: 1 } }))).toThrow(
      "Objects are not valid as a React child",
    );
    expect(() => renderToString(createElement("div", { children: () => null }))).toThrow(
      "Functions are not valid as a React child",
    );
    expect(() => renderToString(createElement("div", { children: Symbol("s") }))).toThrow(
      "Symbols are not valid as a React child",
    );
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
