import { describe, expect, it } from "vitest";
import {
  CLIENT_REFERENCE,
  REACT_ELEMENT_TYPE,
  REACT_SUSPENSE_TYPE,
  SERVER_REFERENCE,
  createClientReference,
  createElement,
  createServerReference,
  lazy,
  use,
} from "../react.ts";
import { createFromReadableStream, deepAwait } from "../react-flight-client.ts";
import { renderToReadableStream } from "../react-flight-server.ts";
import type { Any } from "../shared.ts";
import { delay, gate, roundTrip, rowTag, until } from "./helpers.ts";

describe("leaf encodings", () => {
  it("round-trips every leaf value the protocol supports", async () => {
    const { value } = await roundTrip({
      nil: null,
      undef: undefined,
      yes: true,
      no: false,
      zero: 0,
      negZero: -0,
      nan: NaN,
      inf: Infinity,
      ninf: -Infinity,
      int: 42,
      float: 3.5,
      str: "hello",
      dollarStr: "$0",
      dollarOnly: "$",
      dollarDouble: "$$x",
      bigint: 123n,
      symbol: Symbol.for("test.sym"),
      date: new Date("2026-10-13T00:00:00.000Z"),
      emptyArray: [],
      array: [1, "two", null, [3]],
      emptyObject: {},
      nested: { a: { b: { c: "deep" } } },
    });

    expect(value.nil).toBeNull();
    expect("undef" in value && value.undef === undefined).toBe(true);
    expect(value.yes).toBe(true);
    expect(value.no).toBe(false);
    expect(value.zero).toBe(0);
    expect(Object.is(value.negZero, -0)).toBe(true);
    expect(Number.isNaN(value.nan)).toBe(true);
    expect(value.inf).toBe(Infinity);
    expect(value.ninf).toBe(-Infinity);
    expect(value.int).toBe(42);
    expect(value.float).toBe(3.5);
    expect(value.str).toBe("hello");
    expect(value.dollarStr).toBe("$0");
    expect(value.dollarOnly).toBe("$");
    expect(value.dollarDouble).toBe("$$x");
    expect(value.bigint).toBe(123n);
    expect(value.symbol).toBe(Symbol.for("test.sym"));
    expect(value.date).toBeInstanceOf(Date);
    expect(value.date.toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(value.emptyArray).toEqual([]);
    expect(value.array).toEqual([1, "two", null, [3]]);
    expect(value.emptyObject).toEqual({});
    expect(value.nested.a.b.c).toBe("deep");
  });
});

describe("deduplication", () => {
  it("writes a shared object once and preserves identity through path references", async () => {
    const shared = { id: "shared", tags: ["a"] };
    const { value } = await roundTrip({ a: shared, b: shared, c: { inner: shared } });

    expect(value.a).toBe(value.b);
    expect(value.b).toBe(value.c.inner);
    expect(value.a.id).toBe("shared");
    expect(value.a.tags[0]).toBe("a");
  });

  it("does not dedupe through a key containing a colon", async () => {
    // `$0:a:b` would decode as the path `a` -> `b`, so this key cannot become a
    // path reference; the value is written out in full instead.
    const shared = { tag: "shared" };
    const { value, rows } = await roundTrip({ "a:b": shared, c: shared });

    expect(value["a:b"].tag).toBe("shared");
    expect(value.c.tag).toBe("shared");
    expect(rows.some((row) => row.includes("$0:a:b"))).toBe(false);
  });

  it("dedupes through element props", async () => {
    const shared = { tag: "shared" };
    const { value, rows } = await roundTrip(createElement("div", { a: shared, b: shared }));

    expect(value.props.a).toBe(value.props.b);
    expect(rows.some((row) => row.includes('"$0:props:a"'))).toBe(true);
  });

  it("dedupes across nested elements", async () => {
    const sharedConfig = { role: "shared-config" };
    function Two() {
      return createElement("div", {
        children: [
          createElement("span", { config: sharedConfig }),
          createElement("footer", { children: { config: sharedConfig } }),
        ],
      });
    }
    const { value, rows } = await roundTrip(createElement(Two, {}));

    expect(value.props.children[0].props.config).toBe(
      value.props.children[1].props.children.config,
    );
    expect(rows.join("").split("shared-config")).toHaveLength(2);
  });

  it("preserves identity in cyclic objects", async () => {
    const cyclic: Any = { name: "cyclic" };
    cyclic.self = cyclic;
    const { value } = await roundTrip({ node: cyclic });

    expect(value.node.name).toBe("cyclic");
    expect(value.node.self).toBe(value.node);
  });
});

describe("references", () => {
  it("resolves a client reference used as an element type", async () => {
    const Widget = createClientReference("./Widget.js", "Widget");
    const WidgetComponent = (props: Any) => props;
    const { value } = await roundTrip(
      { element: createElement(Widget, { title: "hi" }), refAsProp: Widget },
      { clientModules: { "./Widget.js": { Widget: WidgetComponent } } },
    );

    expect(value.element.$$typeof).toBe(REACT_ELEMENT_TYPE);
    expect(value.element.type).toBe(WidgetComponent);
    expect(value.element.props.title).toBe("hi");
    // A reference in a value position stays the metadata marker.
    expect(value.refAsProp.$$typeof).toBe(CLIENT_REFERENCE);
    expect(value.refAsProp.id).toBe("./Widget.js");
  });

  it("fails loudly when a client reference cannot be resolved", async () => {
    const Widget = createClientReference("./Widget.js", "Widget");
    await expect(
      roundTrip({ element: createElement(Widget, {}) }),
    ).rejects.toThrow("Could not resolve the client reference");
  });

  it("keeps a server reference as an action marker", async () => {
    const action = createServerReference("./action.js#doThing");
    const { value } = await roundTrip({ action });

    expect(value.action.$$typeof).toBe(SERVER_REFERENCE);
  });

  it("writes one import row per module/export pair", async () => {
    const Widget = createClientReference("./Widget.js", "Widget");
    // A different function object with the same module/export dedupes too.
    const WidgetAgain = createClientReference("./Widget.js", "Widget");
    const WidgetComponent = (props: Any) => props;
    const { value, rows } = await roundTrip(
      {
        a: createElement(Widget, {}),
        b: createElement(WidgetAgain, {}),
        c: Widget,
      },
      { clientModules: { "./Widget.js": { Widget: WidgetComponent } } },
    );

    const imports = rows.filter((row) => rowTag(row) === "I");
    expect(imports).toHaveLength(1);
    expect(value.a.type).toBe(value.b.type);
    expect(value.a.type).toBe(WidgetComponent);
    expect(value.c.$$typeof).toBe(CLIENT_REFERENCE);
  });

  it("writes one metadata row per server action", async () => {
    const action = createServerReference("./action.js#doThing");
    const { value, rows } = await roundTrip({ a: action, b: action });

    expect(value.a.id).toBe(value.b.id);
    expect(rows.length).toBeLessThan(4);
  });
});

describe("elements", () => {
  it("keeps element keys", async () => {
    const { value } = await roundTrip({
      list: [
        createElement("li", { children: "a" }, "k1"),
        createElement("li", { children: "b" }, "k2"),
      ],
    });

    expect(value.list[0].key).toBe("k1");
    expect(value.list[1].key).toBe("k2");
    expect(value.list[0].props.children).toBe("a");
  });
});

describe("server components", () => {
  it("inlines fragments, primitives and nested components", async () => {
    function Frag() {
      return [
        createElement("span", { children: "x" }),
        createElement("span", { children: "y" }),
      ];
    }
    function Text() {
      return "plain text";
    }
    function Num() {
      return 7;
    }
    function Inner({ x }: { x: string }) {
      return createElement("b", { children: x });
    }
    function Outer() {
      return createElement(Inner, { x: "nested" });
    }

    const { value } = await roundTrip({
      frag: createElement(Frag, {}),
      text: createElement(Text, {}),
      num: createElement(Num, {}),
      outer: createElement(Outer, {}),
    });

    expect(Array.isArray(value.frag)).toBe(true);
    expect(value.frag).toHaveLength(2);
    expect(value.frag[0].props.children).toBe("x");
    expect(value.text).toBe("plain text");
    expect(value.num).toBe(7);
    expect(value.outer.props.children).toBe("nested");
  });
});

describe("thenables", () => {
  it("serializes promise props, including an already-fulfilled thenable", async () => {
    const fulfilledThenable: Any = { status: "fulfilled", value: "done", then() {} };
    const { value } = await roundTrip({
      pending: gate(15, { text: "later" }),
      fulfilled: fulfilledThenable,
    });

    expect(value.pending.text).toBe("later");
    expect(value.fulfilled).toBe("done");
  });

  it("treats a thenable root model as a promise reference", async () => {
    const rows: string[] = [];
    const root = createFromReadableStream(renderToReadableStream(gate(40, { ok: true })), {
      onRow: (row) => rows.push(row),
    });

    await until(() => rows.length === 1);
    expect(rows[0]).toMatch(/^0:"\$@[0-9a-f]+"$/);

    const value = await deepAwait(await root);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('"ok":true');
    expect(value.ok).toBe(true);
  });

  it("reuses a reference to a root another row already wrote", async () => {
    const alreadyWritten = { tag: "already-written" };
    // `status: "pending"` keeps the thenable uninstrumented, so the reader takes
    // the pending path and swaps in the resolved value without re-registering it.
    const later: Any = {
      status: "pending",
      then(onFulfilled: (value: Any) => void) {
        setTimeout(() => onFulfilled(alreadyWritten), 10);
      },
    };

    const { value, rows } = await roundTrip({ p: alreadyWritten, later });
    expect(value.later).toBe(value.p);
    expect(value.later.tag).toBe("already-written");
    expect(rows.filter((row) => row.includes("already-written"))).toHaveLength(1);
  });
});

describe("suspense", () => {
  it("resumes a component that suspended through use()", async () => {
    const suspended = gate(15, { msg: "suspended" });
    function Sus() {
      const data = use<{ msg: string }>(suspended);
      return createElement("i", { children: data.msg });
    }

    const { value } = await roundTrip({ s: createElement(Sus, {}) });
    expect(value.s.props.children).toBe("suspended");
  });

  it("outlines a suspended child and keeps its ready sibling", async () => {
    const suspended = gate(15, { msg: "nested suspension" });
    function Sus() {
      const data = use<{ msg: string }>(suspended);
      return createElement("i", { children: data.msg });
    }
    function Parent() {
      return createElement("div", {
        children: [createElement(Sus, {}), createElement("b", { children: "sibling" })],
      });
    }

    const { value, rows } = await roundTrip({ tree: createElement(Parent, {}) });
    expect(value.tree.props.children[0].props.children).toBe("nested suspension");
    expect(value.tree.props.children[1].props.children).toBe("sibling");

    // The shell row keeps the placeholder and the ready sibling.
    expect(rows[0].startsWith("0:")).toBe(true);
    expect(rows[0]).toMatch(/"\$L[0-9a-f]+"/);
    expect(rows[0]).toContain('"sibling"');
    expect(rows.slice(1).some((row) => row.includes('"nested suspension"'))).toBe(true);
  });

  it("keeps a suspense boundary's fallback in the shell row and outlines its children", async () => {
    const SUSPENSE = Symbol.for("react.suspense");
    const suspended = gate(15, { text: "boundary child" });
    function Slow() {
      const data = use<{ text: string }>(suspended);
      return createElement("i", { children: data.text });
    }

    const { value, rows } = await roundTrip({
      root: createElement(SUSPENSE, {
        fallback: createElement("p", { children: "loading..." }),
        children: createElement(Slow, {}),
      }),
    });

    expect(rows[0]).toContain("$Sreact.suspense");
    expect(rows[0]).toContain('"loading..."');
    expect(rows[0]).toMatch(/"\$L[0-9a-f]+"/);
    expect(rows.slice(1).some((row) => row.includes('"boundary child"'))).toBe(true);

    expect(value.root.type).toBe(REACT_SUSPENSE_TYPE);
    expect(value.root.type).toBe(SUSPENSE);
    expect(value.root.props.fallback.props.children).toBe("loading...");
    expect(value.root.props.children.props.children).toBe("boundary child");
  });

  it("outlines an async server component as a lazy reference", async () => {
    const Async = async () => {
      await delay(15);
      return createElement("p", { children: "async" });
    };

    const { value, rows } = await roundTrip({ node: createElement(Async, {}) });
    expect(rows[0]).toMatch(/^0:.*"\$L[0-9a-f]+"/);
    expect(rows[0]).not.toContain("$@");
    expect(rows).toHaveLength(2);
    expect(value.node.type).toBe("p");
    expect(value.node.props.children).toBe("async");
  });

  it("outlines a lazy server component type", async () => {
    const Lazy = lazy(() => gate(15, { default: () => createElement("p", { children: "lazy" }) }));

    const { value, rows } = await roundTrip({ node: createElement(Lazy, {}) });
    expect(rows[0]).toMatch(/^0:.*"\$L[0-9a-f]+"/);
    expect(rows).toHaveLength(2);
    expect(value.node.props.children).toBe("lazy");
  });

  it("outlines a lazy client reference type", async () => {
    const Lazy = lazy(() => gate(15, { default: createClientReference("./L.js", "L") }));
    const L = (props: Any) => props;

    const { value, rows } = await roundTrip(
      { node: createElement(Lazy, {}) },
      { clientModules: { "./L.js": { L } } },
    );
    expect(rows[0]).toMatch(/^0:.*"\$L[0-9a-f]+"/);
    expect(rows.some((row) => rowTag(row) === "I")).toBe(true);
    expect(value.node.type).toBe(L);
  });

  it("resolves a lazy element in a child slot", async () => {
    const Lazy = lazy(() => gate(15, { default: createElement("em", { children: "lazy" }) }));

    const { value, rows } = await roundTrip({ node: createElement("div", { children: Lazy }) });
    expect(rows).toHaveLength(2);
    expect(value.node.props.children.type).toBe("em");
    expect(value.node.props.children.props.children).toBe("lazy");
  });

  it("withholds a row whose own model suspends until it settles", async () => {
    const rows: string[] = [];
    const suspended = gate(30, { text: "root" });
    function Root() {
      const data = use<{ text: string }>(suspended);
      return createElement("div", { children: data.text });
    }

    void createFromReadableStream(renderToReadableStream(createElement(Root, {})), {
      onRow: (row) => rows.push(row),
    });

    await delay(10);
    expect(rows).toHaveLength(0);

    await until(() => rows.length === 1);
    expect(rows[0].startsWith("0:")).toBe(true);
  });

  it("writes a suspending root model's row once, without a self-reference", async () => {
    const suspended = gate(15, { text: "root" });
    function Root2() {
      const data = use<{ text: string }>(suspended);
      return createElement("div", { children: data.text });
    }

    const { value, rows } = await roundTrip(createElement(Root2, {}));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain("$0");
    expect(value.props.children).toBe("root");
  });

  it("writes a row once when a component suspends twice", async () => {
    const first = gate(15, { a: "A" });
    const second = gate(15, { b: "B" });
    function Slow() {
      const d1 = use<{ a: string }>(first);
      const d2 = use<{ b: string }>(second);
      return createElement("p", { children: d1.a + d2.b });
    }

    const { value, rows } = await roundTrip({ root: createElement("div", { children: createElement(Slow, {}) }) });
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toContain("$1");
    expect(value.root.props.children.props.children).toBe("AB");
  });
});

describe("error paths", () => {
  it("propagates a rejected thenable", async () => {
    const rejectedThenable: Any = {
      status: "rejected",
      reason: new Error("thenable boom"),
      then() {},
    };
    await expect(roundTrip({ r: rejectedThenable })).rejects.toThrow("thenable boom");
  });

  it("propagates a throwing server component as a server error", async () => {
    function Boom() {
      throw new Error("component boom");
    }
    await expect(roundTrip({ b: createElement(Boom, {}) })).rejects.toThrow("component boom");
  });

  it("rejects a promise that never settles when the stream is cancelled", async () => {
    let resolvePending!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolvePending = resolve;
    });
    let renders = 0;
    function Suspended() {
      renders++;
      return use(pending);
    }

    const reader = renderToReadableStream({
      child: createElement(Suspended, {}),
    }).getReader();
    await until(() => renders === 1);

    await reader.cancel();
    resolvePending("resolved after cancellation");
    await delay(20);
    expect(renders).toBe(1);
  });
});
