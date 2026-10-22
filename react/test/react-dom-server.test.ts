import { describe, expect, it } from "vitest";
import {
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_SUSPENSE_TYPE,
  Suspense,
  createElement,
  lazy,
  use,
} from "../react.ts";
import {
  prerender,
  prerenderToNodeStream,
  renderToReadableStream,
  renderToString,
} from "../react-dom-server.ts";
import type { Any } from "../shared.ts";
import { deepAwait } from "../react-flight-client.ts";

const el = createElement;

const shellOf = (markers: string, fallback: string): string =>
  '<!--$?--><template id="' + markers + '"></template>' + fallback + "<!--/$-->";

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { done, value } = await reader.read();
  if (done) throw new Error("stream closed before the next chunk");
  return new TextDecoder().decode(value);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let html = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return html + decoder.decode();
    html += decoder.decode(value, { stream: true });
  }
}

async function readNode(stream: NodeJS.ReadableStream): Promise<string> {
  let html = "";
  for await (const chunk of stream as Any) html += String(chunk);
  return html;
}

/** The body of the single inline script a boundary chunk carries. */
function scriptSource(chunk: string): string {
  return chunk.slice(chunk.indexOf("<script>") + "<script>".length, chunk.indexOf("</script>"));
}

describe("renderToReadableStream", () => {
  it("writes the shell first and completes a boundary when it settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    function Slow() {
      use(gate);
      return el("b", { children: "done" });
    }

    const stream = await renderToReadableStream(
      el("div", {
        children: el(Suspense, { fallback: "loading", children: el(Slow, {}) }),
      }),
    );
    const reader = stream.getReader();

    expect(await readChunk(reader)).toBe("<div>" + shellOf("B0", "loading") + "</div>");

    release();
    const chunk = await readChunk(reader);
    expect(chunk).toContain('<div hidden id="S0"><b>done</b></div>');
    expect(chunk).toContain('("B0","S0")');
    expect(() => new Function(scriptSource(chunk))).not.toThrow();

    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("inlines a boundary that finished during the shell pass", async () => {
    const stream = await renderToReadableStream(
      el("div", {
        children: el(Suspense, { fallback: "loading", children: "done" }),
      }),
    );

    expect(await readAll(stream)).toBe("<div><!--$-->done<!--/$--></div>");
  });

  it("completes sibling boundaries in the order their data settles", async () => {
    let releaseA!: (value: string) => void;
    let releaseB!: (value: string) => void;
    const a = new Promise<string>((resolve) => (releaseA = resolve));
    const b = new Promise<string>((resolve) => (releaseB = resolve));

    function Show({ value, label }: { value: Promise<string>; label: string }) {
      return el("b", { children: label + use(value) });
    }

    const stream = await renderToReadableStream(
      el("div", {
        children: [
          el(Suspense, { fallback: "wait-a", children: el(Show, { value: a, label: "a:" }) }),
          el(Suspense, { fallback: "wait-b", children: el(Show, { value: b, label: "b:" }) }),
        ],
      }),
    );
    const reader = stream.getReader();

    expect(await readChunk(reader)).toBe(
      "<div>" + shellOf("B0", "wait-a") + shellOf("B1", "wait-b") + "</div>",
    );

    releaseB("2");
    expect(await readChunk(reader)).toContain('<div hidden id="S1"><b>b:2</b></div>');

    releaseA("1");
    expect(await readChunk(reader)).toContain('<div hidden id="S0"><b>a:1</b></div>');

    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("completes a nested boundary after the content that holds it", async () => {
    let releaseOuter!: () => void;
    let releaseInner!: () => void;
    const outer = new Promise<void>((resolve) => (releaseOuter = resolve));
    const inner = new Promise<void>((resolve) => (releaseInner = resolve));

    function Inner() {
      use(inner);
      return el("i", { children: "inner" });
    }
    function Outer() {
      use(outer);
      return el("span", {
        children: ["outer", el(Suspense, { fallback: "inner-loading", children: el(Inner, {}) })],
      });
    }

    const stream = await renderToReadableStream(
      el("div", {
        children: el(Suspense, { fallback: "outer-loading", children: el(Outer, {}) }),
      }),
    );
    const reader = stream.getReader();

    expect(await readChunk(reader)).toBe("<div>" + shellOf("B0", "outer-loading") + "</div>");

    releaseOuter();
    const content = await readChunk(reader);
    expect(content).toContain(
      '<div hidden id="S0"><span>outer' + shellOf("B1", "inner-loading") + "</span></div>",
    );

    releaseInner();
    expect(await readChunk(reader)).toContain('<div hidden id="S1"><i>inner</i></div>');

    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("discards pending descendants when a parent retry suspends again", async () => {
    let releaseOuter!: () => void;
    let releaseSecond!: () => void;
    let releaseDeep!: () => void;
    const outer = new Promise<void>((resolve) => (releaseOuter = resolve));
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    const deep = new Promise<void>((resolve) => (releaseDeep = resolve));

    function Deep() {
      use(deep);
      return el("i", { children: "deep" });
    }
    function SuspendOnSecond() {
      use(second);
      return "ready";
    }
    function Outer() {
      use(outer);
      return el("section", {
        children: [
          el(Suspense, {
            fallback: "middle-loading",
            children: el(Suspense, {
              fallback: "container-loading",
              children: el(Suspense, { fallback: "deep-loading", children: el(Deep, {}) }),
            }),
          }),
          el(SuspendOnSecond, {}),
        ],
      });
    }

    const stream = await renderToReadableStream(
      el(Suspense, { fallback: "outer-loading", children: el(Outer, {}) }),
    );
    const reader = stream.getReader();

    expect(await readChunk(reader)).toBe(shellOf("B0", "outer-loading"));

    releaseOuter();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseDeep();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    releaseSecond();

    const chunk = await readChunk(reader);
    expect(chunk).toContain('<div hidden id="S0">');
    expect(chunk).not.toContain('id="S3"');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("turns a boundary that rejects after the shell into a client render", async () => {
    let reject!: (reason: Error) => void;
    const gate = new Promise<string>((_, rejectGate) => (reject = rejectGate));
    function Slow() {
      return el("b", { children: use(gate) });
    }

    const errors: Any[] = [];
    const stream = await renderToReadableStream(
      el(Suspense, { fallback: "loading", children: el(Slow, {}) }),
      { onError: (error) => errors.push(error) },
    );
    const reader = stream.getReader();

    expect(await readChunk(reader)).toBe(shellOf("B0", "loading"));

    reject(new Error("nope"));
    const chunk = await readChunk(reader);
    expect(chunk).toContain('data = "$!"');
    expect(chunk).toContain('"nope"');
    expect(() => new Function(scriptSource(chunk))).not.toThrow();
    expect(errors).toHaveLength(1);

    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it("prefixes the ids the reveal script looks up", async () => {
    const never = new Promise<never>(() => {});
    function Slow() {
      use(never);
      return "unreachable";
    }

    const stream = await renderToReadableStream(
      el(Suspense, { fallback: "loading", children: el(Slow, {}) }),
      { identifierPrefix: "app-" },
    );
    const reader = stream.getReader();

    expect(await readChunk(reader)).toBe(shellOf("app-B0", "loading"));
    await reader.cancel();
  });

  it("rejects when something outside a boundary fails", async () => {
    function Boom(): Any {
      throw new Error("root boom");
    }

    await expect(renderToReadableStream(el(Boom, {}))).rejects.toThrow("root boom");
  });

  it("closes the stream when the consumer cancels", async () => {
    const never = new Promise<never>(() => {});
    function Slow() {
      use(never);
      return "unreachable";
    }

    const stream = await renderToReadableStream(
      el(Suspense, { fallback: "loading", children: el(Slow, {}) }),
    );
    const reader = stream.getReader();
    expect(await readChunk(reader)).toBe(shellOf("B0", "loading"));
    await reader.cancel();

    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });
});

describe("prerender", () => {
  it("waits for a boundary and inlines its content", async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => (release = resolve));

    function Slow() {
      return el("b", { children: use(gate) });
    }

    const pending = prerender(
      el("div", {
        children: el(Suspense, { fallback: "loading", children: el(Slow, {}) }),
      }),
    );
    release("done");

    const { prelude, postponed } = await pending;
    expect(await readAll(prelude)).toBe("<div><!--$--><b>done</b><!--/$--></div>");
    expect(postponed).toBe(null);
  });

  it("leaves a boundary pending when the signal aborts", async () => {
    const never = new Promise<never>(() => {});
    function Slow() {
      use(never);
      return "done";
    }

    const controller = new AbortController();
    const pending = prerender(
      el("div", {
        children: el(Suspense, { fallback: "loading", children: el(Slow, {}) }),
      }),
      { signal: controller.signal },
    );
    controller.abort();

    const { prelude, postponed } = await pending;
    expect(await readAll(prelude)).toBe("<div>" + shellOf("B0", "loading") + "</div>");
    expect(postponed).toEqual({ boundaries: [0] });
  });

  it("renders an empty prelude for an already aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const { prelude, postponed } = await prerender(el("p", { children: "hi" }), {
      signal: controller.signal,
    });
    expect(await readAll(prelude)).toBe("");
    expect(postponed).toBe(null);
  });

  it("turns a boundary error into a client-rendered fallback", async () => {
    const errors: Any[] = [];
    function Boom(): Any {
      throw new Error("boom");
    }

    const { prelude, postponed } = await prerender(
      el(Suspense, { fallback: "fallback", children: el(Boom, {}) }),
      { onError: (error) => errors.push(error) },
    );

    expect(await readAll(prelude)).toBe(
      '<!--$!--><template id="B0" data-dgst="" data-msg="boom"></template>fallback<!--/$-->',
    );
    expect(postponed).toBe(null);
    expect(errors).toHaveLength(1);
  });

  it("rejects when something outside a boundary fails", async () => {
    function Boom(): Any {
      throw new Error("root boom");
    }

    await expect(prerender(el(Boom, {}))).rejects.toThrow("root boom");
  });
});

describe("prerenderToNodeStream", () => {
  it("yields the same document as prerender", async () => {
    const { prelude, postponed } = await prerenderToNodeStream(
      el("div", { children: [el("span", { children: "a" }), "b"] }),
    );

    expect(await readNode(prelude)).toBe("<div><span>a</span>b</div>");
    expect(postponed).toBe(null);
  });

  it("reports what it still owes when aborted", async () => {
    const never = new Promise<never>(() => {});
    function Slow() {
      use(never);
      return "done";
    }

    const controller = new AbortController();
    const pending = prerenderToNodeStream(
      el(Suspense, { fallback: "loading", children: el(Slow, {}) }),
      { signal: controller.signal },
    );
    controller.abort();

    const { prelude, postponed } = await pending;
    expect(await readNode(prelude)).toBe(shellOf("B0", "loading"));
    expect(postponed).toEqual({ boundaries: [0] });
  });
});

describe("renderToString", () => {
  const never = new Promise<never>(() => {});

  /** Throws the same pending thenable on every read. */
  function Suspends() {
    use(never);
    return createElement("b", { children: "unreachable" });
  }

  it("renders and escapes text leaves", () => {
    expect(renderToString(null)).toBe("");
    expect(renderToString(undefined)).toBe("");
    expect(renderToString(false)).toBe("");
    expect(renderToString(true)).toBe("");
    expect(renderToString("hi")).toBe("hi");
    expect(renderToString(42)).toBe("42");
    expect(renderToString(-0)).toBe("0");
    expect(renderToString(10n)).toBe("10");
    expect(renderToString(["a", 1, null, false, "b"])).toBe("a1b");
    expect(renderToString("<b>&\"'")).toBe("&lt;b&gt;&amp;&quot;&#x27;");
  });

  it("renders host trees, void tags and unknown tags", () => {
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
    expect(renderToString(createElement("div", {}))).toBe("<div></div>");
    expect(renderToString(createElement("br", {}))).toBe("<br/>");
    expect(renderToString(createElement("hr", {}))).toBe("<hr/>");
    expect(renderToString(createElement("img", { src: "a.png", alt: "" }))).toBe(
      '<img src="a.png" alt=""/>',
    );
    expect(renderToString(createElement("input", { type: "text", value: "v" }))).toBe(
      '<input type="text" value="v"/>',
    );
    expect(renderToString(createElement("my-element", { children: "x" }))).toBe(
      "<my-element>x</my-element>",
    );
  });

  it("maps props to attributes and ignores client-only ones", () => {
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
    expect(
      renderToString(createElement("button", { disabled: true, hidden: false, children: "go" })),
    ).toBe('<button disabled="">go</button>');
    expect(renderToString(createElement("input", { readOnly: true }))).toBe('<input readOnly=""/>');
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
    expect(renderToString(createElement("div", { title: 'a"b&c' }))).toBe(
      '<div title="a&quot;b&amp;c"></div>',
    );
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

  it("serializes style objects", () => {
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
    expect(renderToString(createElement("div", { style: "color:red" }))).toBe(
      '<div style="color:red"></div>',
    );
    expect(renderToString(createElement("div", { style: { color: null } }))).toBe("<div></div>");
    expect(renderToString(createElement("div", { style: { WebkitLineClamp: 2 } }))).toBe(
      '<div style="-webkit-line-clamp:2"></div>',
    );
  });

  it("prefers dangerouslySetInnerHTML over children", () => {
    expect(
      renderToString(
        createElement("div", {
          dangerouslySetInnerHTML: { __html: "<b>raw &amp; bold</b>" },
          children: "ignored",
        }),
      ),
    ).toBe("<div><b>raw &amp; bold</b></div>");
    expect(renderToString(createElement("div", { dangerouslySetInnerHTML: { __html: "" } }))).toBe(
      "<div></div>",
    );
  });

  it("renders fragments, Suspense children and component shapes", () => {
    expect(
      renderToString(
        createElement(REACT_FRAGMENT_TYPE, {
          children: [createElement("a", { children: "1" }), createElement("b", { children: "2" })],
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
    expect(renderToString(createElement("div", { children: createElement(() => null, {}) }))).toBe(
      "<div></div>",
    );

    function Inner() {
      return createElement("b", { children: "nested" });
    }
    const Outer = () => createElement(Inner, {});
    expect(renderToString(createElement(Outer, {}))).toBe("<b>nested</b>");
  });

  it("renders lazy children and explains a synchronous suspension", () => {
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

  it("loads React.lazy once and caches it", async () => {
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

  it("renders the nearest fallback and drops partial output", () => {
    expect(
      renderToString(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: createElement("p", { children: "loading" }),
          children: createElement(Suspends, {}),
        }),
      ),
    ).toBe("<p>loading</p>");
    expect(
      renderToString(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading",
          children: createElement("div", {
            children: [createElement("span", { children: "partial" }), createElement(Suspends, {})],
          }),
        }),
      ),
    ).toBe("loading");
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

  it("keeps ready siblings of a suspended boundary", () => {
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

  it("rejects a suspension with no boundary", () => {
    expect(() => renderToString(createElement(Suspends, {}))).toThrow("no <Suspense> boundary");
  });

  it("throws for invalid element types and children", () => {
    expect(() => renderToString(createElement(42, {}))).toThrow("Element type is invalid");
    expect(() => renderToString(createElement({}, {}))).toThrow("Element type is invalid");
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
