import { describe, expect, it } from "vitest";
import {
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_SUSPENSE_TYPE,
  createElement,
  lazy,
} from "../react.ts";
import type { Any } from "../shared.ts";
import { createRoot, renderToString } from "../react-dom.ts";
import { asElement, mount, TestDocument, TestText } from "./dom-shim.ts";
import { deepAwait } from "../react-flight-client.ts";

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
