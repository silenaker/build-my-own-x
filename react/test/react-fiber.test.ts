/**
 * Tests for the Fiber reconciler in `react-fiber.ts`, driven by
 * `createFiberDomRoot`.
 *
 * The reconciler's contract has two halves, and the suites below follow them:
 *
 * - render plans and commit executes. Render builds fibers and records on them
 *   exactly what the commit must do (`completeWork` diffs, flags, the deletion
 *   list); the commit performs that plan once, in a fixed order, and never asks
 *   the document for information the fiber tree already holds.
 * - the output has to match the reference client. The `parity` suite renders
 *   one tree through `createRoot` (the walker in `react-dom-core.ts`) and
 *   through `createFiberDomRoot`, then compares the documents they leave.
 *
 * Everything else is covered against the fiber client alone: host output,
 * reconciliation, properties, `dangerouslySetInnerHTML`, hooks, effects,
 * suspense, teardown and the errors the reconciler raises.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_SUSPENSE_TYPE,
  createElement,
  createLazyWrapper,
  lazy,
  startTransition,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "../react.ts";
import type { Any } from "../shared.ts";
import { createFiberDomRoot, createRoot, type ReactDomRoot } from "../react-dom-client.ts";
import { flushSync, setFrameBudgetMs } from "../react-fiber.ts";
import {
  asElement,
  mount,
  TestDocument,
  TestElement,
  TestNode,
  TestText,
  type RootFactory,
} from "./dom-shim.ts";
import { delay, gate, until } from "./helpers.ts";

// ---- Helpers ---------------------------------------------------------------

/** A fresh container and the fiber root that owns it. */
function fiberRoot(): { container: TestElement; root: ReactDomRoot } {
  const document = new TestDocument();
  const container = document.createElement("root");
  const root = createFiberDomRoot(container as unknown as Element);
  return { container, root };
}

/** Render into a fresh container and hand back the container. */
function render(element: Any, container?: TestElement): TestElement {
  const target = container ?? new TestDocument().createElement("root");
  createFiberDomRoot(target as unknown as Element).render(element);
  return target;
}

/**
 * Deliver a click. The dispatch only queues what the handler causes; a test
 * commits it by wrapping the event in `act`.
 */
function click(node: TestNode): void {
  asElement(node).dispatch("click", {});
}

/** Commit the work `scope` queued, the way React's `act` does. */
function act(scope: () => void): void {
  flushSync(scope);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Any) => void;
}

/** A promise whose settlement the test controls. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Markup with every attribute inline, so a moved or rebuilt node shows up. */
function shape(node: TestNode): string {
  if (node instanceof TestText) return JSON.stringify(node.data);
  if (node instanceof TestElement) {
    const attributes = [...node.attributes]
      .map(([name, value]) => " " + name + "=" + JSON.stringify(value))
      .join("");
    const children = node.childNodes.map(shape).join("");
    return "<" + node.tagName + attributes + ">" + children + "</" + node.tagName + ">";
  }
  return node.childNodes.map(shape).join("");
}

function markupOf(create: RootFactory, element: Any): string {
  return shape(mount(element, create));
}

function rootOf(create: RootFactory, element: Any): { container: TestElement; root: ReactDomRoot } {
  const document = new TestDocument();
  const container = document.createElement("root");
  const root = create(container as unknown as Element);
  root.render(element);
  return { container, root };
}

// ---- Host output -----------------------------------------------------------

describe("host output", () => {
  it("renders nested arrays, numbers, booleans, null and undefined in order", () => {
    const container = render(
      createElement("div", {
        children: ["a", 1, null, false, undefined, ["b", ["c", 2]]],
      }),
    );
    const div = asElement(container.childNodes[0]);
    expect(div.textContent).toBe("a1bc2");
    expect(div.childNodes.map((node) => node.nodeType)).toEqual([3, 3, 3, 3, 3]);
  });

  it("renders strings and numbers as text nodes, not elements", () => {
    const container = render("text");
    expect(container.childNodes.length).toBe(1);
    expect(container.childNodes[0] instanceof TestText).toBe(true);
    expect((container.childNodes[0] as TestText).data).toBe("text");
  });

  it("renders a fragment without a wrapper element", () => {
    const container = render(
      createElement(REACT_FRAGMENT_TYPE, {
        children: [
          createElement("i", { children: "one" }),
          createElement("i", { children: "two" }),
        ],
      }),
    );
    expect(container.childNodes.map((node) => asElement(node).tagName)).toEqual(["i", "i"]);
    expect(container.textContent).toBe("onetwo");
  });

  it("renders a component's output under the host parent", () => {
    function Inner() {
      return createElement("b", { children: "inner" });
    }
    function Outer() {
      return createElement("div", { children: createElement(Inner, {}) });
    }

    const container = render(createElement(Outer, {}));
    expect(shape(container)).toBe('<root><div><b>"inner"</b></div></root>');
  });

  it("renders nothing for an empty tree", () => {
    const container = render(null);
    expect(container.childNodes).toEqual([]);
  });

  it("resolves a lazy element type that does not suspend", () => {
    function Loaded() {
      return createElement("b", { children: "lazy" });
    }
    const Lazy = createLazyWrapper(() => Loaded);

    const container = render(createElement(Lazy, {}));
    expect(container.textContent).toBe("lazy");
  });
});

// ---- Reconciliation --------------------------------------------------------

describe("reconciliation", () => {
  it("keeps the nodes a re-render did not change", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("div", { id: "app", children: "text" }));
    const div = asElement(container.childNodes[0]);
    const text = div.childNodes[0];

    root.render(createElement("div", { id: "app", children: "text" }));
    expect(asElement(container.childNodes[0])).toBe(div);
    expect(div.childNodes[0]).toBe(text);
  });

  it("updates a text node in place", () => {
    const { container, root } = fiberRoot();
    root.render("one");
    const text = container.childNodes[0];

    root.render("two");
    expect(container.childNodes.length).toBe(1);
    expect(container.childNodes[0]).toBe(text);
    expect((text as TestText).data).toBe("two");
  });

  it("leaves a text node alone when the next text is the same", () => {
    const { container, root } = fiberRoot();
    root.render("one");
    const text = container.childNodes[0] as TestText;
    text.data = "tampered";

    // Render plans from the previous props, so it does not notice the write.
    root.render("one");
    expect(text.data).toBe("tampered");
  });

  it("replaces an element when its tag changes", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("div", { children: "same" }));
    const div = asElement(container.childNodes[0]);

    root.render(createElement("span", { children: "same" }));
    expect(container.childNodes.length).toBe(1);
    expect(asElement(container.childNodes[0])).not.toBe(div);
    expect(asElement(container.childNodes[0]).tagName).toBe("span");
    expect(div.parentNode).toBe(null);
  });

  it("remounts a component when the element type changes", () => {
    function First() {
      return createElement("b", { children: "first" });
    }
    function Second() {
      return createElement("b", { children: "second" });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(First, {}));
    const bold = asElement(container.childNodes[0]);

    root.render(createElement(Second, {}));
    expect(container.textContent).toBe("second");
    expect(asElement(container.childNodes[0])).not.toBe(bold);
  });

  it("moves keyed children instead of rebuilding them", () => {
    const list = (order: string[]) =>
      createElement("ul", {
        children: order.map((label) => createElement("li", { children: label }, label)),
      });

    const { container, root } = fiberRoot();
    root.render(list(["a", "b", "c"]));
    const ul = asElement(container.childNodes[0]);
    const [a, b, c] = ul.childNodes;

    root.render(list(["c", "a", "b"]));
    expect(asElement(container.childNodes[0])).toBe(ul);
    expect(ul.childNodes).toEqual([c, a, b]);
  });

  it("inserts and removes keyed children without touching the survivors", () => {
    const list = (order: string[]) =>
      createElement("ul", {
        children: order.map((label) => createElement("li", { children: label }, label)),
      });

    const { container, root } = fiberRoot();
    root.render(list(["a", "b", "c"]));
    const ul = asElement(container.childNodes[0]);
    const [a, b, c] = ul.childNodes;

    root.render(list(["b", "d", "a"]));
    expect(asElement(container.childNodes[0])).toBe(ul);
    expect(ul.childNodes.map((node) => asElement(node).textContent)).toEqual(["b", "d", "a"]);
    expect(ul.childNodes[0]).toBe(b);
    expect(ul.childNodes[2]).toBe(a);
    expect(c.parentNode).toBe(null);
  });

  it("keeps state with a key when keyed children reorder", () => {
    function Item({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return createElement("li", {
        onClick: () => setCount((previous) => previous + 1),
        children: label + ":" + count,
      });
    }
    const list = (labels: string[]) =>
      createElement("ul", {
        children: labels.map((label) => createElement(Item, { label }, label)),
      });

    const { container, root } = fiberRoot();
    root.render(list(["a", "b"]));
    act(() => click(container.childNodes[0].childNodes[0]));
    expect(container.textContent).toBe("a:1b:0");

    root.render(list(["b", "a"]));
    expect(container.textContent).toBe("b:0a:1");
  });

  it("follows position for unkeyed children", () => {
    function Item({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return createElement("li", {
        onClick: () => setCount((previous) => previous + 1),
        children: label + ":" + count,
      });
    }
    const list = (labels: string[]) =>
      createElement("ul", {
        children: labels.map((label) => createElement(Item, { label })),
      });

    const { container, root } = fiberRoot();
    root.render(list(["a", "b"]));
    act(() => click(container.childNodes[0].childNodes[0]));
    expect(container.textContent).toBe("a:1b:0");

    // Without keys, state belongs to the slot, not to the label.
    root.render(list(["b", "a"]));
    expect(container.textContent).toBe("b:1a:0");
  });

  it("remounts when a key changes", () => {
    function Item({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return createElement("li", {
        onClick: () => setCount((previous) => previous + 1),
        children: label + ":" + count,
      });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(Item, { label: "a" }, "one"));
    act(() => click(container.childNodes[0]));
    expect(container.textContent).toBe("a:1");

    root.render(createElement(Item, { label: "a" }, "two"));
    expect(container.textContent).toBe("a:0");
  });
});

// ---- Properties and events -------------------------------------------------

describe("properties and events", () => {
  it("applies attributes, aliases, boolean props and style on mount", () => {
    const container = render(
      createElement("label", {
        className: "field",
        htmlFor: "name",
        defaultValue: "typed",
        defaultChecked: true,
        disabled: true,
        draggable: false,
        title: "hint",
        "data-count": 3,
        style: { color: "red", fontSize: 12, flexGrow: 2 },
        children: "label",
      }),
    );
    const label = asElement(container.childNodes[0]);
    expect(label.getAttribute("class")).toBe("field");
    expect(label.getAttribute("for")).toBe("name");
    expect(label.getAttribute("value")).toBe("typed");
    expect(label.getAttribute("checked")).toBe("");
    expect(label.getAttribute("disabled")).toBe("");
    expect(label.getAttribute("draggable")).toBe("false");
    expect(label.getAttribute("title")).toBe("hint");
    expect(label.getAttribute("data-count")).toBe("3");
    expect(label.getAttribute("style")).toBe("color:red;font-size:12px;flex-grow:2");
  });

  it("drops stale attributes and removes boolean props that turn false", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("button", { title: "old", disabled: true, children: "go" }));
    const button = asElement(container.childNodes[0]);
    expect(button.getAttributeNames().sort()).toEqual(["disabled", "title"]);

    root.render(createElement("button", { disabled: false, children: "go" }));
    expect(button.getAttributeNames()).toEqual([]);
  });

  it("replaces a changed listener instead of stacking another", () => {
    const calls: string[] = [];
    const { container, root } = fiberRoot();
    root.render(
      createElement("button", {
        onClick: () => calls.push("first"),
        children: "go",
      }),
    );
    const button = asElement(container.childNodes[0]);
    const second = () => calls.push("second");

    root.render(createElement("button", { onClick: second, children: "go" }));
    expect(button.listeners.get("click")).toEqual([second]);
    act(() => click(button));
    expect(calls).toEqual(["second"]);
  });

  it("leaves an unchanged listener attached once", () => {
    const calls: string[] = [];
    const listener = () => calls.push("click");
    const { container, root } = fiberRoot();
    const tree = createElement("button", { onClick: listener, children: "go" });

    root.render(tree);
    const button = asElement(container.childNodes[0]);
    root.render(createElement("button", { onClick: listener, children: "go" }));

    expect(button.listeners.get("click")).toEqual([listener]);
    act(() => click(button));
    expect(calls).toEqual(["click"]);
  });

  it("ignores values that are not valid attributes or listeners", () => {
    const container = render(
      createElement("div", {
        children: "x",
        title: { value: "object" },
        id: Symbol("id"),
        onClick: "not a function",
        checked: false,
      }),
    );
    const div = asElement(container.childNodes[0]);
    expect(div.getAttributeNames()).toEqual([]);
    expect(div.listeners.size).toBe(0);
  });

  it("diffs against the previous props, not the document", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("div", { title: "planned" }));
    const div = asElement(container.childNodes[0]);
    div.setAttribute("title", "tampered");

    root.render(createElement("div", { title: "planned" }));
    // The plan is empty, so an attribute written outside the reconciler stays.
    expect(div.getAttribute("title")).toBe("tampered");
  });
});

// ---- dangerouslySetInnerHTML -----------------------------------------------

describe("dangerouslySetInnerHTML", () => {
  it("writes the markup on mount and ignores children", () => {
    const container = render(
      createElement("div", {
        dangerouslySetInnerHTML: { __html: "<b>raw</b>" },
        children: createElement("i", { children: "ignored" }),
      }),
    );
    const div = asElement(container.childNodes[0]);
    expect(div.rawHTML).toBe("<b>raw</b>");
    expect(div.childNodes).toEqual([]);
  });

  it("rewrites the markup when it changes and leaves it alone when props are identical", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("div", { dangerouslySetInnerHTML: { __html: "<b>one</b>" } }));
    const div = asElement(container.childNodes[0]);

    root.render(createElement("div", { dangerouslySetInnerHTML: { __html: "<b>two</b>" } }));
    expect(div.rawHTML).toBe("<b>two</b>");

    // Same props object as the last render: the plan is empty, so the node is
    // not touched even though its markup was changed behind the reconciler.
    div.rawHTML = "sentinel";
    root.render(createElement("div", { dangerouslySetInnerHTML: { __html: "<b>two</b>" } }));
    expect(div.rawHTML).toBe("sentinel");
  });

  it("clears the markup before placing children", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } }));
    const div = asElement(container.childNodes[0]);

    root.render(createElement("div", { children: createElement("span", { children: "hi" }) }));
    expect(asElement(container.childNodes[0])).toBe(div);
    expect(div.rawHTML).toBe("");
    expect(div.childNodes.length).toBe(1);
    expect(div.textContent).toBe("hi");
  });

  it("unmounts the children the markup replaces", () => {
    const log: string[] = [];
    function Child() {
      useLayoutEffect(() => {
        log.push("mount");
        return () => log.push("cleanup");
      }, []);
      return createElement("b", { children: "text" });
    }

    const { container, root } = fiberRoot();
    root.render(createElement("div", { children: createElement(Child, {}) }));
    const div = asElement(container.childNodes[0]);
    const bold = asElement(div.childNodes[0]);
    expect(log).toEqual(["mount"]);

    root.render(createElement("div", { dangerouslySetInnerHTML: { __html: "<i>raw</i>" } }));
    expect(log).toEqual(["mount", "cleanup"]);
    expect(asElement(container.childNodes[0])).toBe(div);
    expect(bold.parentNode).toBe(null);
    expect(div.rawHTML).toBe("<i>raw</i>");
  });
});

// ---- Hooks -----------------------------------------------------------------

describe("hooks", () => {
  it("mounts and updates state, including functional updates", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount((previous) => previous + 1),
        children: "count:" + count,
      });
    }

    const container = render(createElement(Counter, {}));
    act(() => click(container.childNodes[0]));
    act(() => click(container.childNodes[0]));
    expect(container.textContent).toBe("count:2");
  });

  it("runs a lazy initializer once", () => {
    let initializations = 0;
    function Counter() {
      const [count, setCount] = useState(() => {
        initializations++;
        return 10;
      });
      return createElement("button", {
        onClick: () => setCount((previous) => previous + 5),
        children: String(count),
      });
    }

    const container = render(createElement(Counter, {}));
    expect(container.textContent).toBe("10");
    expect(initializations).toBe(1);

    act(() => click(container.childNodes[0]));
    expect(container.textContent).toBe("15");
    expect(initializations).toBe(1);
  });

  it("keeps multiple states independent", () => {
    function Pair() {
      const [a, setA] = useState(0);
      const [b, setB] = useState(100);
      return createElement("div", {
        children: [
          createElement("button", { onClick: () => setA(a + 1), children: "a" + a }),
          createElement("button", { onClick: () => setB(b + 1), children: "b" + b }),
        ],
      });
    }

    const container = render(createElement(Pair, {}));
    const buttons = () => asElement(container.childNodes[0]).childNodes;
    expect(container.textContent).toBe("a0b100");

    act(() => click(buttons()[0]));
    expect(container.textContent).toBe("a1b100");

    act(() => click(buttons()[1]));
    expect(container.textContent).toBe("a1b101");
  });

  it("applies queued updates once and drops them when the commit lands", () => {
    function Comp() {
      const [count, setCount] = useState(0);
      const [tick, setTick] = useState(0);
      useLayoutEffect(() => {
        if (count === 0) {
          // Both dispatches land while the flush is running, so they queue.
          setCount((previous) => previous + 1);
          setCount((previous) => previous + 1);
        }
      }, [count]);
      return createElement("button", {
        onClick: () => setTick((previous) => previous + 1),
        children: "count:" + count + " tick:" + tick,
      });
    }

    const container = render(createElement(Comp, {}));
    expect(container.textContent).toBe("count:2 tick:0");

    // The commit consumed the two actions, so a later update does not replay them.
    act(() => click(container.childNodes[0]));
    expect(container.textContent).toBe("count:2 tick:1");
  });

  it("does not replay an action a commit already consumed", () => {
    let updaterCalls = 0;
    function Comp() {
      const [, setCount] = useState(0);
      const [tick, setTick] = useState(0);
      return createElement("button", {
        onClick: () => {
          // The first update changes no output of its own.
          setCount((previous) => {
            updaterCalls++;
            return previous + 1;
          });
          // A second dispatch renders again: the first action is already spent.
          setTick((previous) => previous + 1);
        },
        children: "tick:" + tick,
      });
    }

    const container = render(createElement(Comp, {}));
    act(() => click(container.childNodes[0]));
    expect(container.textContent).toBe("tick:1");
    expect(updaterCalls).toBe(1);
  });

  it("does not replay an action when the update changes nothing on screen", () => {
    let updaterCalls = 0;
    let bump: () => void = () => {};
    const seen: number[] = [];

    function Comp() {
      const [count, setCount] = useState(0);
      seen.push(count);
      bump = () =>
        setCount((previous) => {
          updaterCalls++;
          return previous + 1;
        });
      // Nothing here reads `count`, and the props are compared by value, so the
      // render flags no host mutation at all: the consumed action is the only
      // thing that keeps this fiber inside the commit walk.
      return createElement("div", { children: "static" });
    }

    const container = render(createElement(Comp, {}));
    act(bump);
    act(bump);

    expect(container.textContent).toBe("static");
    expect(seen).toEqual([0, 1, 2]);
    // Each action ran once, in the render that consumed it; none was replayed.
    expect(updaterCalls).toBe(2);
  });

  it("drives useReducer with an initializer that runs once", () => {
    let initializations = 0;
    function Counter() {
      const [count, dispatch] = useReducer(
        (state: number, action: "inc" | "dec") => (action === "inc" ? state + 1 : state - 1),
        1,
        (start) => {
          initializations++;
          return start * 10;
        },
      );
      return createElement("div", {
        children: [
          createElement("button", { onClick: () => dispatch("dec"), children: "dec" }),
          createElement("button", { onClick: () => dispatch("inc"), children: "inc" }),
          createElement("b", { children: String(count) }),
        ],
      });
    }

    const container = render(createElement(Counter, {}));
    expect(container.textContent).toBe("decinc10");
    expect(initializations).toBe(1);

    act(() => click(container.childNodes[0].childNodes[1]));
    expect(container.textContent).toBe("decinc11");

    act(() => click(container.childNodes[0].childNodes[0]));
    expect(container.textContent).toBe("decinc10");
    expect(initializations).toBe(1);
  });

  it("keeps a ref object stable across renders", () => {
    const refs: Array<{ current: number }> = [];
    function Comp({ value }: { value: number }) {
      const ref = useRef(0);
      refs.push(ref);
      ref.current = value;
      return createElement("b", { children: String(ref.current) });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(Comp, { value: 1 }));
    root.render(createElement(Comp, { value: 2 }));

    expect(refs.length).toBe(2);
    expect(refs[0]).toBe(refs[1]);
    expect(refs[1].current).toBe(2);
    expect(container.textContent).toBe("2");
  });

  it("recomputes useMemo only when deps change and keeps useCallback identity", () => {
    let computations = 0;
    const callbacks: Array<() => void> = [];
    function Comp({ value, other }: { value: number; other: number }) {
      const doubled = useMemo(() => {
        computations++;
        return value * 2;
      }, [value]);
      const callback = useCallback(() => value, [value]);
      callbacks.push(callback);
      return createElement("b", { children: doubled + ":" + other });
    }

    const { root } = fiberRoot();
    root.render(createElement(Comp, { value: 1, other: 0 }));
    root.render(createElement(Comp, { value: 1, other: 1 }));
    expect(computations).toBe(1);
    expect(callbacks[0]).toBe(callbacks[1]);

    root.render(createElement(Comp, { value: 2, other: 1 }));
    expect(computations).toBe(2);
    expect(callbacks[1]).not.toBe(callbacks[2]);
  });

  it("recomputes useMemo without a dep list on every render", () => {
    let computations = 0;
    function Comp() {
      const value = useMemo(() => ++computations, undefined);
      return createElement("b", { children: String(value) });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(Comp, {}));
    root.render(createElement(Comp, {}));
    expect(container.textContent).toBe("2");
  });

  it("throws when a render uses fewer hooks than the previous one", () => {
    function Comp({ extra }: { extra: boolean }) {
      const [first] = useState(0);
      if (extra) useState(1);
      return createElement("b", { children: String(first) });
    }

    const { root } = fiberRoot();
    root.render(createElement(Comp, { extra: true }));
    expect(() => root.render(createElement(Comp, { extra: false }))).toThrow(
      "Rendered fewer hooks than expected",
    );
  });

  it("rejects a hook call outside a component", () => {
    expect(() => useState(0)).toThrow("Invalid hook call");
  });

  it("ignores a dispatch after unmount", () => {
    let set: Any = null;
    function Comp() {
      const [count, setCount] = useState(0);
      set = setCount;
      return createElement("b", { children: "count:" + count });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(Comp, {}));
    root.unmount();
    expect(() => set(1)).not.toThrow();
    expect(container.childNodes).toEqual([]);
  });
});

// ---- Effects ---------------------------------------------------------------

describe("effects", () => {
  it("runs layout effects against the committed tree, before passive effects", async () => {
    const log: string[] = [];
    const { container, root } = fiberRoot();

    function Comp() {
      useLayoutEffect(() => {
        log.push("layout:" + container.textContent);
      }, []);
      useEffect(() => {
        log.push("passive:" + container.textContent);
      }, []);
      return createElement("b", { children: "committed" });
    }

    root.render(createElement(Comp, {}));
    expect(log).toEqual(["layout:committed"]);
    await delay(10);
    expect(log).toEqual(["layout:committed", "passive:committed"]);
  });

  it("runs layout effects child-first, then passive effects child-first", async () => {
    const log: string[] = [];
    function Parent() {
      useLayoutEffect(() => {
        log.push("layout parent");
      }, []);
      useEffect(() => {
        log.push("passive parent");
      }, []);
      return createElement(Child, {});
    }
    function Child() {
      useLayoutEffect(() => {
        log.push("layout child");
      }, []);
      useEffect(() => {
        log.push("passive child");
      }, []);
      return createElement("b", { children: "x" });
    }

    mount(createElement(Parent, {}), createFiberDomRoot);
    expect(log).toEqual(["layout child", "layout parent"]);
    await delay(10);
    expect(log).toEqual(["layout child", "layout parent", "passive child", "passive parent"]);
  });

  it("reruns an effect only when its deps change and cleans up first", () => {
    const log: string[] = [];
    function Comp({ value }: { value: number }) {
      useLayoutEffect(() => {
        log.push("layout " + value);
        return () => log.push("cleanup " + value);
      }, [value]);
      return createElement("b", { children: String(value) });
    }

    const { root } = fiberRoot();
    root.render(createElement(Comp, { value: 1 }));
    root.render(createElement(Comp, { value: 1 }));
    expect(log).toEqual(["layout 1"]);

    root.render(createElement(Comp, { value: 2 }));
    expect(log).toEqual(["layout 1", "cleanup 1", "layout 2"]);
  });

  it("flushes the previous commit's passive effects before the next render", async () => {
    const log: string[] = [];
    function Comp({ value }: { value: number }) {
      useEffect(() => {
        log.push("effect " + value);
        return () => log.push("cleanup " + value);
      });
      return createElement("b", { children: String(value) });
    }

    const { root } = fiberRoot();
    root.render(createElement(Comp, { value: 1 }));
    expect(log).toEqual([]);

    root.render(createElement(Comp, { value: 2 }));
    expect(log).toEqual(["effect 1"]);

    await delay(10);
    expect(log).toEqual(["effect 1", "cleanup 1", "effect 2"]);
  });

  it("settles a state update made by a layout effect in the same flush", () => {
    const log: string[] = [];
    function Comp() {
      const [ready, setReady] = useState(false);
      useLayoutEffect(() => {
        log.push("layout " + ready);
        if (!ready) setReady(true);
      }, [ready]);
      return createElement("b", { children: ready ? "ready" : "first" });
    }

    const container = render(createElement(Comp, {}));
    expect(container.textContent).toBe("ready");
    expect(log).toEqual(["layout false", "layout true"]);
  });

  it("runs cleanups parent-first when a subtree is deleted", async () => {
    const log: string[] = [];
    function Parent() {
      useLayoutEffect(() => {
        return () => log.push("layout parent cleanup");
      }, []);
      useEffect(() => {
        return () => log.push("passive parent cleanup");
      }, []);
      return createElement(Child, {});
    }
    function Child() {
      useLayoutEffect(() => {
        return () => log.push("layout child cleanup");
      }, []);
      useEffect(() => {
        return () => log.push("passive child cleanup");
      }, []);
      return createElement("span", { children: "child" });
    }

    const { root } = fiberRoot();
    root.render(createElement("div", { children: createElement(Parent, {}) }));
    await delay(10);

    // Deleting the wrapper unmounts the component subtree under it.
    root.render(createElement("div", {}));
    expect(log).toEqual([
      "layout parent cleanup",
      "passive parent cleanup",
      "layout child cleanup",
      "passive child cleanup",
    ]);
  });
});

// ---- Updates and bailouts --------------------------------------------------

describe("updates and bailouts", () => {
  it("skips a component whose element props are identical", () => {
    let renders = 0;
    function Comp() {
      renders++;
      return createElement("b", { children: "x" });
    }

    const { root } = fiberRoot();
    const tree = createElement(Comp, {});
    root.render(tree);
    root.render(tree);
    expect(renders).toBe(1);
  });

  it("re-renders when the element is recreated even with equal props", () => {
    let renders = 0;
    function Comp() {
      renders++;
      return createElement("b", { children: "x" });
    }

    const { root } = fiberRoot();
    root.render(createElement(Comp, {}));
    root.render(createElement(Comp, {}));
    expect(renders).toBe(2);
  });

  it("descends to a dirty child through a parent that bails out", () => {
    let parentRenders = 0;
    let childRenders = 0;

    function Child() {
      const [count, setCount] = useState(0);
      childRenders++;
      return createElement("button", {
        onClick: () => setCount((previous) => previous + 1),
        children: "count:" + count,
      });
    }

    const child = createElement(Child, {});
    function Parent() {
      parentRenders++;
      return child;
    }

    const container = render(createElement(Parent, {}));
    const button = asElement(container.childNodes[0]);
    act(() => click(button));
    act(() => click(button));

    expect(container.textContent).toBe("count:2");
    expect(parentRenders).toBe(1);
    expect(childRenders).toBe(3);
  });

  // A bailout replaces the fiber with its alternate and never runs the
  // component, so its dispatch closure still points at the previous fiber. The
  // lane has to be on both sides: only the current one is copied forward, and
  // `createWorkInProgress` overwrites the other side with it.
  it("applies an update dispatched from a fiber a bailout turned into the alternate", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount((previous) => previous + 1),
        children: "count:" + count,
      });
    }
    function Toggler() {
      const [on, setOn] = useState(false);
      return createElement("button", {
        onClick: () => setOn((previous) => !previous),
        children: on ? "on" : "off",
      });
    }

    const { container, root } = fiberRoot();
    root.render(
      createElement("div", {
        children: [createElement(Counter, {}), createElement(Toggler, {})],
      }),
    );

    // The toggler re-renders the whole path, but Counter's element is the same
    // object and carries no lane, so Counter bails out: a clone takes its place
    // as current, and the fiber the dispatch holds becomes the alternate.
    act(() => click(container.childNodes[0].childNodes[1]));

    act(() => click(container.childNodes[0].childNodes[0]));
    expect(container.textContent).toBe("count:1on");
  });

  it("updates sibling components independently", () => {
    let firstRenders = 0;
    let secondRenders = 0;

    function First() {
      const [count, setCount] = useState(0);
      firstRenders++;
      return createElement("button", {
        onClick: () => setCount((previous) => previous + 1),
        children: "first:" + count,
      });
    }
    function Second() {
      secondRenders++;
      return createElement("button", { children: "second" });
    }

    const container = render(
      createElement("div", {
        children: [createElement(First, {}), createElement(Second, {})],
      }),
    );

    act(() => click(container.childNodes[0].childNodes[0]));
    expect(container.textContent).toBe("first:1second");
    expect(firstRenders).toBe(2);
    expect(secondRenders).toBe(1);
  });
});

// ---- Suspense --------------------------------------------------------------

describe("suspense", () => {
  it("shows the fallback and then the content once the thenable settles", async () => {
    const pending = deferred<string>();
    function Show() {
      return createElement("b", { children: use(pending.promise) });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(Show, {}),
      }),
      createFiberDomRoot,
    );
    expect(container.textContent).toBe("loading");

    pending.resolve("ready");
    await until(() => container.textContent === "ready");
    expect(shape(container)).toBe('<root><b>"ready"</b></root>');
  });

  it("never commits content that completed before the suspension", () => {
    const pending = deferred<string>();
    function Show() {
      use(pending.promise);
      return null;
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement("div", {
          children: [createElement("b", { children: "before" }), createElement(Show, {})],
        }),
      }),
      createFiberDomRoot,
    );

    // The `<b>` was built during the discarded attempt; it must not appear.
    expect(container.textContent).toBe("loading");
    expect(container.childNodes.length).toBe(1);
  });

  it("lets the nearest boundary catch a suspension", async () => {
    const pending = deferred<string>();
    function Inner() {
      return createElement("b", { children: use(pending.promise) });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "outer",
        children: createElement("div", {
          children: [
            createElement("i", { children: "outer content" }),
            createElement(REACT_SUSPENSE_TYPE, {
              fallback: "inner",
              children: createElement(Inner, {}),
            }),
          ],
        }),
      }),
      createFiberDomRoot,
    );
    expect(container.textContent).toBe("outer contentinner");

    pending.resolve("ready");
    await until(() => container.textContent === "outer contentready");
  });

  it("retries every boundary that waits on the same thenable", async () => {
    const pending = deferred<string>();
    function Show({ label }: { label: string }) {
      return createElement("b", { children: label + ":" + use(pending.promise) });
    }

    const container = mount(
      createElement("div", {
        children: [
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "one",
            children: createElement(Show, { label: "a" }),
          }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "two",
            children: createElement(Show, { label: "b" }),
          }),
        ],
      }),
      createFiberDomRoot,
    );
    expect(container.textContent).toBe("onetwo");

    pending.resolve("x");
    await until(() => container.textContent === "a:xb:x");
  });

  it("retries a boundary without re-rendering its siblings", async () => {
    const pending = deferred<string>();
    let siblingRenders = 0;
    function Sibling() {
      siblingRenders++;
      return createElement("i", { children: "sibling" });
    }
    function Show() {
      return createElement("b", { children: use(pending.promise) });
    }

    const tree = createElement("div", {
      children: [
        createElement(Sibling, {}),
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading",
          children: createElement(Show, {}),
        }),
      ],
    });

    const { container, root } = fiberRoot();
    root.render(tree);
    expect(container.textContent).toBe("siblingloading");
    const before = siblingRenders;

    pending.resolve("ready");
    await until(() => container.textContent === "siblingready");
    expect(siblingRenders).toBe(before);
  });

  it("updates a component inside the fallback while the content is suspended", () => {
    const thenable: Any = { status: undefined, then: () => thenable };
    function Show() {
      use(thenable);
      return null;
    }
    function Fallback() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount((previous) => previous + 1),
        children: "fallback:" + count,
      });
    }

    const container = render(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: createElement(Fallback, {}),
        children: createElement(Show, {}),
      }),
    );
    expect(container.textContent).toBe("fallback:0");

    act(() => click(container.childNodes[0]));
    expect(container.textContent).toBe("fallback:1");
  });

  it("keeps the committed node and hook state across a suspended retry", async () => {
    const pending = deferred<string>();

    function Content({ suspend, label }: { suspend: boolean; label: string }) {
      if (suspend) use(pending.promise);
      const [count, setCount] = useState(0);
      return createElement("b", {
        onClick: () => setCount((previous) => previous + 1),
        children: label + ":" + count,
      });
    }
    function App({ suspend }: { suspend: boolean }) {
      return createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(Content, { suspend, label: "c" }),
      });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(App, { suspend: false }));
    const bold = asElement(container.childNodes[0]);
    act(() => click(bold));
    act(() => click(bold));
    expect(container.textContent).toBe("c:2");

    root.render(createElement(App, { suspend: true }));
    expect(container.textContent).toBe("loading");
    expect(bold.parentNode).toBe(null);

    pending.resolve("ready");
    await until(() => container.textContent === "c:2");
    // The content came back from the stash: same node, same hook state.
    expect(asElement(container.childNodes[0])).toBe(bold);
  });

  it("updates the fallback while the content keeps suspending", () => {
    const thenable: Any = { status: undefined, then: () => thenable };
    function Show() {
      use(thenable);
      return null;
    }
    function App({ tick }: { tick: number }) {
      return createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading " + tick,
        children: createElement(Show, {}),
      });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(App, { tick: 0 }));
    expect(container.textContent).toBe("loading 0");

    root.render(createElement(App, { tick: 1 }));
    expect(container.textContent).toBe("loading 1");
  });

  it("renders a lazy component once its module loads", async () => {
    function Loaded() {
      return createElement("b", { children: "loaded" });
    }
    const loading = gate(1, { default: Loaded });
    const Lazy = lazy(() => loading);

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(Lazy, {}),
      }),
      createFiberDomRoot,
    );
    expect(container.textContent).toBe("loading");
    await until(() => container.textContent === "loaded");
  });

  it("stops waiting when the boundary leaves the tree", async () => {
    const pending = deferred<string>();
    function Show() {
      return createElement("b", { children: use(pending.promise) });
    }

    const { container, root } = fiberRoot();
    root.render(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(Show, {}),
      }),
    );
    expect(container.textContent).toBe("loading");

    root.render(null);
    expect(container.childNodes).toEqual([]);

    pending.resolve("late");
    await delay(10);
    expect(container.childNodes).toEqual([]);
  });

  it("renders a fulfilled thenable without suspending", () => {
    const thenable: Any = { status: "fulfilled", value: "ready" };
    function Show() {
      return createElement("b", { children: use(thenable) });
    }

    const container = render(createElement(Show, {}));
    expect(container.textContent).toBe("ready");
  });

  it("throws the reason of an already rejected thenable", () => {
    const thenable: Any = { status: "rejected", reason: new Error("nope") };
    function Show() {
      return createElement("b", { children: use(thenable) });
    }

    expect(() =>
      render(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading",
          children: createElement(Show, {}),
        }),
      ),
    ).toThrow("nope");
  });
});

// ---- Errors ----------------------------------------------------------------

describe("errors", () => {
  it("requires a container that belongs to a document", () => {
    expect(() => createFiberDomRoot({ ownerDocument: null } as unknown as Element)).toThrow(
      "requires a container that belongs to a document",
    );
  });

  it("rejects objects, functions and symbols as children", () => {
    const cases: Array<[Any, string]> = [
      [{}, "Objects are not valid as a React child"],
      [() => null, "Functions are not valid as a React child"],
      [Symbol("child"), "Symbols are not valid as a React child"],
    ];

    for (const [child, message] of cases) {
      expect(() => render(createElement("div", { children: child }))).toThrow(message);
    }
  });

  it("rejects an element type that is neither a tag nor a component", () => {
    expect(() => render(createElement(42, null))).toThrow("Element type is invalid");
    expect(() => render(createElement({}, null))).toThrow("Element type is invalid");
  });

  it("rejects a lazy wrapper without an initializer", () => {
    const broken = { $$typeof: REACT_LAZY_TYPE } as Any;
    expect(() => render(createElement(broken, null))).toThrow("Invalid lazy element type");
  });

  it("explains a suspension that has no boundary", () => {
    const thenable: Any = { status: undefined, then: () => thenable };
    function Show() {
      use(thenable);
      return null;
    }

    expect(() => render(createElement(Show, {}))).toThrow("no <Suspense> boundary");
  });
});

// ---- Teardown --------------------------------------------------------------

describe("unmount", () => {
  it("runs the cleanups and empties the container", async () => {
    const log: string[] = [];
    function Comp() {
      useLayoutEffect(() => {
        log.push("layout");
        return () => log.push("layout cleanup");
      }, []);
      useEffect(() => {
        log.push("passive");
        return () => log.push("passive cleanup");
      }, []);
      return createElement("div", { children: "mounted" });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(Comp, {}));
    await delay(10);
    root.unmount();

    expect(log).toEqual(["layout", "passive", "layout cleanup", "passive cleanup"]);
    expect(container.childNodes).toEqual([]);
  });

  it("flushes a pending passive create before tearing the tree down", () => {
    const log: string[] = [];
    function Comp() {
      useLayoutEffect(() => {
        log.push("layout");
        return () => log.push("layout cleanup");
      }, []);
      useEffect(() => {
        log.push("passive");
        return () => log.push("passive cleanup");
      }, []);
      return createElement("div", { children: "mounted" });
    }

    const { container, root } = fiberRoot();
    root.render(createElement(Comp, {}));
    // The passive phase has not run yet when the root goes away.
    root.unmount();

    expect(log).toEqual(["layout", "passive", "layout cleanup", "passive cleanup"]);
    expect(container.childNodes).toEqual([]);
  });

  it("ignores renders after unmount", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("div", { children: "mounted" }));
    root.unmount();

    root.render(createElement("div", { children: "late" }));
    expect(container.childNodes).toEqual([]);
  });

  it("can be called more than once", () => {
    const { container, root } = fiberRoot();
    root.render(createElement("div", { children: "mounted" }));
    root.unmount();
    expect(() => root.unmount()).not.toThrow();
    expect(container.childNodes).toEqual([]);
  });
});

// ---- Concurrency -----------------------------------------------------------

/**
 * Lanes, the time-sliced work loop and `startTransition`.
 *
 * These tests pin the three things a lane buys the client: a transition never
 * lands in the task that scheduled it, a concurrent render survives a slice
 * boundary instead of starting over, and urgent work preempts it.
 */
describe("concurrency", () => {
  /** The budget a slice gets in production; tests lower it to force a yield. */
  const DEFAULT_FRAME_BUDGET_MS = 5;

  afterEach(() => {
    setFrameBudgetMs(DEFAULT_FRAME_BUDGET_MS);
  });

  it("does not commit a transition inside the task that scheduled it", async () => {
    let setCount!: (value: number) => void;

    function Counter() {
      const [count, set] = useState(0);
      setCount = set;
      return createElement("b", { children: "c" + count });
    }

    const container = render(createElement(Counter, {}));
    expect(container.textContent).toBe("c0");

    startTransition(() => setCount(1));
    // The render is its own task, so the screen still holds the old tree.
    expect(container.textContent).toBe("c0");

    await until(() => container.textContent === "c1");
  });

  it("lets an urgent update overtake a pending transition", async () => {
    let startSlow!: () => void;
    let setUrgent!: (value: number) => void;

    function Slow() {
      const [slow, setSlow] = useState(0);
      startSlow = () => startTransition(() => setSlow(1));
      return createElement("b", { children: "s" + slow });
    }
    function Urgent() {
      const [urgent, set] = useState(0);
      setUrgent = set;
      return createElement("i", { children: "u" + urgent });
    }

    const container = render(
      createElement("div", { children: [createElement(Slow, {}), createElement(Urgent, {})] }),
    );
    expect(container.textContent).toBe("s0u0");

    startSlow();
    act(() => setUrgent(1));

    // The urgent update ran straight away; the transition has not rendered yet.
    expect(container.textContent).toBe("s0u1");
    await until(() => container.textContent === "s1u1");
  });

  it("finishes a transition that a sync update interrupted", async () => {
    let startSlow!: () => void;
    let setUrgent!: (value: number) => void;

    function Slow() {
      const [slow, setSlow] = useState(0);
      startSlow = () => startTransition(() => setSlow(1));
      return createElement("b", { children: "s" + slow });
    }
    function Urgent() {
      const [urgent, set] = useState(0);
      setUrgent = set;
      return createElement("i", { children: "u" + urgent });
    }

    setFrameBudgetMs(0);
    const container = render(
      createElement("div", { children: [createElement(Slow, {}), createElement(Urgent, {})] }),
    );

    startSlow();
    // Let the first slice run and yield; the render is now parked mid-tree.
    await delay(0);
    act(() => setUrgent(1));
    expect(container.textContent).toBe("s0u1");

    // The abandoned transition is scheduled again and finishes on its own.
    await until(() => container.textContent === "s1u1");
  });

  it("renders a transition in more than one slice", async () => {
    let showList!: () => void;

    function Item({ label }: { label: string }) {
      return createElement("i", { children: label });
    }
    function App() {
      const [shown, setShown] = useState(false);
      showList = () => startTransition(() => setShown(true));
      const items = shown ? Array.from({ length: 30 }, (_, index) => `#${index}`) : [];
      return createElement("div", {
        children: items.map((label) => createElement(Item, { label })),
      });
    }

    setFrameBudgetMs(0);
    const container = render(createElement(App, {}));
    expect(container.textContent).toBe("");

    showList();
    // One slice may run, but thirty children cannot all fit in it.
    await delay(0);
    expect(container.textContent).not.toBe(
      "#0#1#2#3#4#5#6#7#8#9#10#11#12#13#14#15#16#17#18#19#20#21#22#23#24#25#26#27#28#29",
    );

    await until(
      () =>
        container.textContent ===
        "#0#1#2#3#4#5#6#7#8#9#10#11#12#13#14#15#16#17#18#19#20#21#22#23#24#25#26#27#28#29",
    );
  });

  it("reports useTransition's pending state until the work commits", async () => {
    function App() {
      const [isPending, start] = useTransition();
      const [value, setValue] = useState("idle");
      return createElement("button", {
        onClick: () => start(() => setValue("done")),
        children: (isPending ? "pending:" : "") + value,
      });
    }

    const container = render(createElement(App, {}));
    expect(container.textContent).toBe("idle");

    act(() => click(container.childNodes[0]));
    // Marking the component pending is urgent, so it is on screen right away.
    expect(container.textContent).toBe("pending:idle");

    await until(() => container.textContent === "done");
  });

  it("clears useTransition's flag when the scope schedules no work", () => {
    function App() {
      const [isPending, start] = useTransition();
      return createElement("button", {
        onClick: () => start(() => {}),
        children: isPending ? "pending" : "idle",
      });
    }

    const container = render(createElement(App, {}));
    expect(container.textContent).toBe("idle");

    act(() => click(container.childNodes[0]));
    // Nothing was dispatched, so there is no lane to wait for.
    expect(container.textContent).toBe("idle");
  });

  it("keeps content on screen when a transition suspends", async () => {
    let resolveContent!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      resolveContent = resolve;
    });
    let startSwap!: () => void;

    function Content({ value }: { value: Promise<string> }) {
      return createElement("b", { children: use(value) });
    }
    // Already settled, so the mount has content to keep on screen.
    const first = Promise.resolve("first") as Any;
    first.status = "fulfilled";
    first.value = "first";

    function App() {
      const [isPending, start] = useTransition();
      const [value, setValue] = useState<Promise<string>>(first);
      startSwap = () => start(() => setValue(pending));
      return createElement("div", {
        children: [
          createElement("span", { children: isPending ? "pending" : "idle" }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "loading",
            children: createElement(Content, { value }),
          }),
        ],
      });
    }

    const container = render(createElement(App, {}));
    expect(container.textContent).toBe("idlefirst");

    act(startSwap);
    // The boundary keeps the content it already shows while the transition waits.
    expect(container.textContent).toBe("pendingfirst");
    await delay(0);
    expect(container.textContent).toBe("pendingfirst");

    resolveContent("second");
    await until(() => container.textContent === "idlesecond");
  });

  it("does not let a suspended transition block another one", async () => {
    const blocked = deferred<string>();

    function Slow() {
      return createElement("b", { children: use(blocked.promise) });
    }
    let startFirst!: () => void;
    let startSecond!: () => void;

    function App() {
      const [first, setFirst] = useState(false);
      const [second, setSecond] = useState(0);
      startFirst = () => startTransition(() => setFirst(true));
      startSecond = () => startTransition(() => setSecond(1));
      return createElement("div", {
        children: [
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "wait",
            children: first ? createElement(Slow, {}) : null,
          }),
          createElement("i", { children: "s" + second }),
        ],
      });
    }

    const container = render(createElement(App, {}));
    expect(container.textContent).toBe("s0");

    // The first transition suspends on its data.
    startFirst();
    await delay(0);
    expect(container.textContent).toBe("s0");

    // A transition started afterwards has its own lane, so the one that is
    // waiting does not hold it back.
    startSecond();
    await until(() => container.textContent === "s1");

    blocked.resolve("ready");
    await until(() => container.textContent === "readys1");
  });

  it("keeps an async transition open until it settles", async () => {
    const gate = deferred<void>();
    let run!: () => void;

    function App() {
      const [isPending, start] = useTransition();
      const [value, setValue] = useState("idle");
      run = () =>
        start(async () => {
          await gate.promise;
          // Still part of the transition, even though it runs after the await.
          setValue("done");
        });
      return createElement("span", { children: (isPending ? "pending:" : "") + value });
    }

    const container = render(createElement(App, {}));
    expect(container.textContent).toBe("idle");

    act(run);
    expect(container.textContent).toBe("pending:idle");

    gate.resolve();
    await until(() => container.textContent === "done");
  });

  it("clears useTransition's flag when the scope throws", () => {
    function App() {
      const [isPending, start] = useTransition();
      return createElement("button", {
        onClick: () => {
          try {
            start(() => {
              throw new Error("boom");
            });
          } catch {
            // The failure belongs to the caller, not to the transition.
          }
        },
        children: isPending ? "pending" : "idle",
      });
    }

    const container = render(createElement(App, {}));
    act(() => click(container.childNodes[0]));
    // Nothing was dispatched, so the flag must not stick.
    expect(container.textContent).toBe("idle");
  });

  it("batches the updates of one event into a single render", () => {
    let renders = 0;

    function Comp() {
      const [count, setCount] = useState(0);
      renders++;
      return createElement("button", {
        onClick: () => {
          setCount((previous) => previous + 1);
          setCount((previous) => previous + 1);
        },
        children: "n" + count,
      });
    }

    const container = render(createElement(Comp, {}));
    expect(renders).toBe(1);

    // A raw dispatch: the handler runs, but nothing renders while it does.
    asElement(container.childNodes[0]).dispatch("click", {});
    expect(container.textContent).toBe("n0");
    expect(renders).toBe(1);

    // The microtask that closes the task commits both actions at once.
    act(() => {});
    expect(container.textContent).toBe("n2");
    expect(renders).toBe(2);
  });

  it("applies an event's updates only after the event returns", async () => {
    let container!: TestElement;
    let seenInsideHandler = "";

    function App() {
      const [isPending, start] = useTransition();
      const [value, setValue] = useState("idle");
      return createElement("button", {
        onClick: () => {
          start(() => setValue("done"));
          // The pending flag is urgent, but even urgent work waits for the
          // handler to return before it renders.
          seenInsideHandler = container.textContent;
        },
        children: (isPending ? "pending:" : "") + value,
      });
    }

    container = render(createElement(App, {}));
    asElement(container.childNodes[0]).dispatch("click", {});

    expect(seenInsideHandler).toBe("idle");
    expect(container.textContent).toBe("idle");

    await until(() => container.textContent === "done");
  });
});

// ---- Parity with the reference client --------------------------------------

describe("parity with createRoot", () => {
  it("writes the same markup", () => {
    const tree = createElement("section", {
      id: "app",
      className: "shell",
      children: [
        "hello ",
        createElement("b", { children: "world" }),
        createElement(REACT_FRAGMENT_TYPE, {
          children: [
            createElement("i", { children: "one" }),
            createElement("i", { children: "two" }),
          ],
        }),
        42,
        null,
        false,
      ],
    });

    const walker = markupOf(createRoot, tree);
    expect(walker).toBe(
      '<root><section id="app" class="shell">"hello "<b>"world"</b><i>"one"</i><i>"two"</i>"42"</section></root>',
    );
    expect(markupOf(createFiberDomRoot, tree)).toBe(walker);
  });

  it("renders the same tree for the same state update", () => {
    const run = (create: RootFactory): string => {
      function Counter() {
        const [count, setCount] = useState(0);
        return createElement("button", {
          onClick: () => setCount(count + 1),
          children: String(count),
        });
      }

      const container = mount(createElement(Counter, {}), create);
      act(() => click(container.childNodes[0]));
      act(() => click(container.childNodes[0]));
      return shape(container);
    };

    const walker = run(createRoot);
    expect(walker).toBe('<root><button>"2"</button></root>');
    expect(run(createFiberDomRoot)).toBe(walker);
  });

  it("writes the same text after an update", () => {
    const run = (create: RootFactory): string => {
      const { container, root } = rootOf(create, createElement("p", { children: "one" }));
      root.render(createElement("p", { children: "two" }));
      return shape(container);
    };

    const walker = run(createRoot);
    expect(walker).toBe('<root><p>"two"</p></root>');
    expect(run(createFiberDomRoot)).toBe(walker);
  });

  it("moves a keyed child instead of rebuilding it", () => {
    const list = (order: string[]) =>
      createElement("ul", {
        children: order.map((label) => createElement("li", { children: label }, label)),
      });

    const run = (create: RootFactory): string => {
      const { container, root } = rootOf(create, list(["a", "b", "c"]));
      const ul = asElement(container.childNodes[0]);
      const [a, b, c] = ul.childNodes;

      root.render(list(["c", "a", "b"]));
      // The document keeps the nodes; only their order changes.
      expect(asElement(container.childNodes[0])).toBe(ul);
      expect(ul.childNodes).toEqual([c, a, b]);
      return shape(container);
    };

    const walker = run(createRoot);
    expect(walker).toBe('<root><ul><li>"c"</li><li>"a"</li><li>"b"</li></ul></root>');
    expect(run(createFiberDomRoot)).toBe(walker);
  });

  it("drops stale attributes and swaps listeners on update", () => {
    const run = (create: RootFactory) => {
      const calls: string[] = [];
      const { container, root } = rootOf(
        create,
        createElement("button", {
          title: "old",
          disabled: true,
          onClick: () => calls.push("first"),
          children: "go",
        }),
      );
      const button = asElement(container.childNodes[0]);
      const before = shape(button);

      root.render(createElement("button", { onClick: () => calls.push("second"), children: "go" }));
      button.dispatch("click", {});
      return { before, after: shape(button), calls };
    };

    const walker = run(createRoot);
    expect(walker.before).toBe('<button title="old" disabled="">"go"</button>');
    expect(walker.after).toBe('<button>"go"</button>');
    // The replaced listener is gone, not added beside the old one.
    expect(walker.calls).toEqual(["second"]);
    expect(run(createFiberDomRoot)).toEqual(walker);
  });

  it("shows the same fallback and then the same content", async () => {
    const run = async (create: RootFactory) => {
      const pending = deferred<string>();
      function Show() {
        return createElement("b", { children: use(pending.promise) });
      }

      const container = mount(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading",
          children: createElement(Show, {}),
        }),
        create,
      );
      const fallback = shape(container);

      pending.resolve("ready");
      await until(() => container.textContent === "ready");
      return { fallback, content: shape(container) };
    };

    const walker = await run(createRoot);
    expect(walker.fallback).toBe('<root>"loading"</root>');
    expect(walker.content).toBe('<root><b>"ready"</b></root>');
    expect(await run(createFiberDomRoot)).toEqual(walker);
  });

  it("keeps one listener per thenable however often the boundary re-renders", () => {
    const run = (create: RootFactory) => {
      // `then` never calls back, so the boundary stays on its fallback and each
      // call is one registration with the host.
      let registrations = 0;
      const thenable: Any = {
        status: undefined,
        then() {
          registrations++;
          return thenable;
        },
      };

      function Show() {
        return createElement("b", { children: use(thenable) });
      }
      function App({ tick }: { tick: number }) {
        return createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading " + tick,
          children: createElement(Show, {}),
        });
      }

      const { container, root } = rootOf(create, createElement(App, { tick: 0 }));
      const first = registrations;
      root.render(createElement(App, { tick: 1 }));
      root.render(createElement(App, { tick: 2 }));
      return { first, after: registrations, shape: shape(container) };
    };

    const walker = run(createRoot);
    // One call instruments the thenable for `use`, one belongs to the boundary.
    expect(walker.first).toBe(2);
    expect(walker.after).toBe(walker.first);
    expect(walker.shape).toBe('<root>"loading 2"</root>');
    expect(run(createFiberDomRoot)).toEqual(walker);
  });

  it("runs layout effects before passive effects in the same order", async () => {
    const run = async (create: RootFactory) => {
      const log: string[] = [];

      function Child({ name }: { name: string }) {
        useLayoutEffect(() => {
          log.push("layout:" + name);
        }, []);
        useEffect(() => {
          log.push("passive:" + name);
        }, []);
        return createElement("span", { children: name });
      }

      mount(
        createElement("div", {
          children: [createElement(Child, { name: "a" }), createElement(Child, { name: "b" })],
        }),
        create,
      );
      const afterRender = log.slice();
      await delay(10);
      return { afterRender, afterPassive: log.slice() };
    };

    const walker = await run(createRoot);
    expect(walker.afterRender).toEqual(["layout:a", "layout:b"]);
    expect(walker.afterPassive).toEqual(["layout:a", "layout:b", "passive:a", "passive:b"]);
    expect(await run(createFiberDomRoot)).toEqual(walker);
  });

  it("writes the same innerHTML", () => {
    const tree = createElement("div", { dangerouslySetInnerHTML: { __html: "<b>raw</b>" } });

    const walker = mount(tree, createRoot).childNodes[0] as TestElement;
    const fiber = mount(tree, createFiberDomRoot).childNodes[0] as TestElement;
    expect(walker.innerHTML).toBe("<b>raw</b>");
    expect(fiber.innerHTML).toBe(walker.innerHTML);
  });

  it("runs the same cleanups and empties the container on unmount", async () => {
    const run = async (create: RootFactory) => {
      const log: string[] = [];

      function Comp() {
        useLayoutEffect(() => {
          log.push("layout");
          return () => log.push("layout cleanup");
        }, []);
        useEffect(() => {
          log.push("passive");
          return () => log.push("passive cleanup");
        }, []);
        return createElement("div", { children: "mounted" });
      }

      const { container, root } = rootOf(create, createElement(Comp, {}));
      // Both phases have to have run, so each one owes a cleanup.
      await delay(10);
      root.unmount();
      return { log: log.slice(), after: shape(container) };
    };

    const walker = await run(createRoot);
    expect(walker.log).toEqual(["layout", "passive", "layout cleanup", "passive cleanup"]);
    expect(walker.after).toBe("<root></root>");
    expect(await run(createFiberDomRoot)).toEqual(walker);
  });

  // Deletion fires cleanups top-down, the opposite of the bottom-up order an
  // update uses. Both orders are contract, so both clients have to agree.
  it("runs layout cleanups parent -> child when a subtree is deleted", () => {
    const run = (create: RootFactory) => {
      const log: string[] = [];

      function Parent() {
        useLayoutEffect(() => {
          return () => log.push("unmount parent");
        }, []);
        return createElement(Child, {});
      }
      function Child() {
        useLayoutEffect(() => {
          return () => log.push("unmount child");
        }, []);
        return createElement("span", { children: "child" });
      }

      const { root } = rootOf(create, createElement(Parent, {}));
      root.unmount();
      return log.slice();
    };

    const walker = run(createRoot);
    expect(walker).toEqual(["unmount parent", "unmount child"]);
    expect(run(createFiberDomRoot)).toEqual(walker);
  });

  it("runs passive cleanups parent -> child when a subtree is deleted", async () => {
    const run = async (create: RootFactory) => {
      const log: string[] = [];

      function Parent() {
        useEffect(() => {
          return () => log.push("unmount parent");
        }, []);
        return createElement(Child, {});
      }
      function Child() {
        useEffect(() => {
          return () => log.push("unmount child");
        }, []);
        return createElement("span", { children: "child" });
      }

      const { root } = rootOf(create, createElement(Parent, {}));
      // Both effects have to have run, so each one owes a cleanup.
      await delay(10);
      root.unmount();
      return log.slice();
    };

    const walker = await run(createRoot);
    expect(walker).toEqual(["unmount parent", "unmount child"]);
    expect(await run(createFiberDomRoot)).toEqual(walker);
  });
});
