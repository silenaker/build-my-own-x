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
import { delay, until } from "./helpers.ts";

describe("suspense", () => {
  const never = new Promise<never>(() => {});
  const click = (node: Any): void => asElement(node).dispatch("click", {});

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

  it("retries every boundary that waits on the same thenable", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));

    function Show({ label }: { label: string }) {
      return createElement("b", { children: label + use(pending) });
    }
    const boundary = (label: string) =>
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: label + "waiting",
        children: createElement(Show, { label }),
      });

    const container = mount(createElement("div", { children: [boundary("a:"), boundary("b:")] }));
    expect(container.textContent).toBe("a:waitingb:waiting");

    // One settlement has to release both boundaries: each keeps its own retry.
    settle("1");
    await until(() => container.textContent === "a:1b:1");
  });

  it("drops a pending retry when a re-render removes the boundary", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));
    let renders = 0;

    function Show() {
      return createElement("b", { children: "show:" + use(pending) });
    }
    function Replacement() {
      renders++;
      return createElement("p", { children: "gone" });
    }

    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);
    root.render(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: createElement("p", { children: "loading" }),
        children: createElement(Show, {}),
      }),
    );
    expect(container.textContent).toBe("loading");

    // The root pass no longer renders the boundary, so its wait dies with it.
    root.render(createElement(Replacement, {}));
    expect(container.textContent).toBe("gone");
    expect(renders).toBe(1);

    // The data arrives for a boundary that is no longer on screen: no rebuild.
    settle("late");
    await delay(10);
    expect(renders).toBe(1);
    expect(container.textContent).toBe("gone");
  });

  it("drops a pending retry when a targeted update removes the boundary", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));
    let renders = 0;

    function Show() {
      return createElement("b", { children: "show:" + use(pending) });
    }
    function Shell() {
      renders++;
      const [hidden, setHidden] = useState(false);
      return createElement("div", {
        children: [
          createElement("button", { onClick: () => setHidden(true), children: "hide" }),
          hidden
            ? null
            : createElement(REACT_SUSPENSE_TYPE, {
                fallback: "loading",
                children: createElement(Show, {}),
              }),
        ],
      });
    }

    const container = mount(createElement(Shell, {}));
    expect(container.textContent).toBe("hideloading");
    expect(renders).toBe(1);

    // A scoped pass owns only its own subtree: the wait inside it goes away.
    asElement(asElement(container.childNodes[0]).childNodes[0]).dispatch("click", {});
    expect(container.textContent).toBe("hide");
    expect(renders).toBe(2);

    settle("late");
    await delay(10);
    expect(renders).toBe(2);
    expect(container.textContent).toBe("hide");
  });

  it("drops the waits a discarded attempt armed inside its content", async () => {
    let settleNested!: (value: string) => void;
    const nested = new Promise<string>((resolve) => (settleNested = resolve));
    const stillWaiting = new Promise<void>(() => {});
    let renders = 0;

    function Nested() {
      return createElement("b", { children: "nested:" + use(nested) });
    }
    function Outer({ armed }: { armed: boolean }) {
      if (armed) use(stillWaiting);
      return null;
    }
    function Shell() {
      renders++;
      const [armed, setArmed] = useState(false);
      return createElement("div", {
        children: [
          createElement("button", { onClick: () => setArmed(true), children: "arm" }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "outer-wait",
            children: [
              createElement(REACT_SUSPENSE_TYPE, {
                fallback: "nested-wait",
                children: createElement(Nested, {}),
              }),
              createElement(Outer, { armed }),
            ],
          }),
        ],
      });
    }

    const container = mount(createElement(Shell, {}));
    // The nested boundary shows its own fallback inside the committed content.
    expect(container.textContent).toBe("armnested-wait");

    // Arming makes the outer content suspend, so that whole attempt is dropped
    // and the nested boundary armed inside it never reached the screen.
    asElement(asElement(container.childNodes[0]).childNodes[0]).dispatch("click", {});
    expect(container.textContent).toBe("armouter-wait");
    const before = renders;

    settleNested("done");
    await delay(10);
    expect(renders).toBe(before);
    expect(container.textContent).toBe("armouter-wait");
  });

  it("runs one retry per settlement when a pending boundary re-renders", async () => {
    let settle!: (value: string) => void;
    const data = new Promise<string>((resolve) => (settle = resolve));
    /** Never resolves, so every retry suspends again and stays countable. */
    const stillWaiting = new Promise<string>(() => {});
    let attempts = 0;

    function Show({ count }: { count: number }) {
      attempts++;
      const value = use(data);
      use(stillWaiting);
      return createElement("b", { children: value + count });
    }
    function Shell() {
      const [count, setCount] = useState(0);
      return createElement("div", {
        children: [
          createElement("button", { onClick: () => setCount(count + 1), children: "n:" + count }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "loading",
            children: createElement(Show, { count }),
          }),
        ],
      });
    }

    const container = mount(createElement(Shell, {}));
    const div = asElement(container.childNodes[0]);
    const button = asElement(div.childNodes[0]);
    expect(container.textContent).toBe("n:0loading");

    // The ancestor's update re-renders the boundary, which suspends again: it
    // keeps its single wait and only names a newer retry.
    button.dispatch("click", {});
    expect(container.textContent).toBe("n:1loading");
    const before = attempts;

    settle("done");
    await until(() => attempts > before);
    await delay(10);

    // One settlement runs one retry, however often the boundary rendered before.
    expect(attempts).toBe(before + 1);
    expect(asElement(div.childNodes[0])).toBe(button);
    expect(container.textContent).toBe("n:1loading");
  });

  it("ignores a settlement for a boundary that was replaced", async () => {
    let settleFirst!: (value: string) => void;
    let settleSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => (settleFirst = resolve));
    const second = new Promise<string>((resolve) => (settleSecond = resolve));
    let renders = 0;

    function Show({ value }: { value: Promise<string> }) {
      return createElement("b", { children: "content:" + use(value) });
    }
    function Shell() {
      renders++;
      const [shown, setShown] = useState(true);
      const [useSecond, setUseSecond] = useState(false);
      return createElement("div", {
        children: [
          createElement("button", {
            onClick: () => {
              setShown(!shown);
              if (shown) setUseSecond(true);
            },
            children: "toggle",
          }),
          shown
            ? createElement(REACT_SUSPENSE_TYPE, {
                fallback: "loading",
                children: createElement(Show, { value: useSecond ? second : first }),
              })
            : null,
        ],
      });
    }

    const container = mount(createElement(Shell, {}));
    const div = asElement(container.childNodes[0]);
    const button = asElement(div.childNodes[0]);
    expect(container.textContent).toBe("toggleloading");

    // Drop the boundary and bring it back on another thenable at the same path.
    button.dispatch("click", {});
    expect(container.textContent).toBe("toggle");
    button.dispatch("click", {});
    expect(container.textContent).toBe("toggleloading");
    const before = renders;

    // The first thenable belongs to a wait that is no longer the boundary's.
    settleFirst("a");
    await delay(10);
    expect(renders).toBe(before);
    expect(container.textContent).toBe("toggleloading");

    // The boundary's own thenable still settles it.
    settleSecond("b");
    await until(() => container.textContent === "togglecontent:b");
  });

  it("ignores a settlement for a thenable the boundary moved off", async () => {
    let settleFirst!: (value: string) => void;
    let settleSecond!: (value: string) => void;
    const first = new Promise<string>((resolve) => (settleFirst = resolve));
    const second = new Promise<string>((resolve) => (settleSecond = resolve));
    /** Never resolves, so every attempt suspends again and stays countable. */
    const stillWaiting = new Promise<string>(() => {});
    let attempts = 0;

    function Show({ value }: { value: Promise<string> }) {
      attempts++;
      const text = use(value);
      use(stillWaiting);
      return createElement("b", { children: "content:" + text });
    }
    function Shell() {
      const [swapped, setSwapped] = useState(false);
      return createElement("div", {
        children: [
          createElement("button", { onClick: () => setSwapped(true), children: "swap" }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "wait",
            children: createElement(Show, { value: swapped ? second : first }),
          }),
        ],
      });
    }

    const container = mount(createElement(Shell, {}));
    const div = asElement(container.childNodes[0]);
    expect(container.textContent).toBe("swapwait");

    // The same boundary, at the same path, now waits on the second thenable.
    // The old registration for the first one is still around.
    asElement(div.childNodes[0]).dispatch("click", {});
    expect(container.textContent).toBe("swapwait");
    expect(attempts).toBe(2);

    // The thenable the boundary no longer waits on must not wake it, even though
    // the wait was armed for it first.
    settleFirst("a");
    await delay(10);
    expect(attempts).toBe(2);

    // The thenable it does wait on runs exactly one attempt.
    settleSecond("b");
    await until(() => attempts === 3);
    await delay(10);
    expect(attempts).toBe(3);
    expect(container.textContent).toBe("swapwait");
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

  it("retries a boundary without re-rendering the rest of the tree", async () => {
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));
    const calls = { app: 0, async: 0, other: 0 };

    function Async() {
      calls.async++;
      return createElement("b", { children: use(pending) });
    }
    function Other() {
      calls.other++;
      return createElement("span", { children: "other" });
    }
    function App() {
      calls.app++;
      return createElement("div", {
        children: [
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "wait",
            children: createElement(Async, {}),
          }),
          createElement(Other, {}),
        ],
      });
    }

    const container = mount(createElement(App, {}));
    expect(container.textContent).toBe("waitother");
    expect(calls).toEqual({ app: 1, async: 1, other: 1 });

    settle("ready");
    await until(() => container.textContent === "readyother");
    // The retry replaced the boundary's range only; ancestors and siblings stayed put.
    expect(calls).toEqual({ app: 1, async: 2, other: 1 });
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

  it("retries an inner boundary without re-rendering the outer content", async () => {
    const calls = { outer: 0, inner: 0, sibling: 0 };
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (settle = resolve));

    function Async() {
      calls.inner++;
      return createElement("b", { children: use(pending) });
    }
    function Sibling() {
      calls.sibling++;
      return createElement("i", { children: "s" });
    }
    function Outer() {
      calls.outer++;
      return createElement("div", {
        children: [
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "inner-wait",
            children: createElement(Async, {}),
          }),
          createElement(Sibling, {}),
        ],
      });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "outer-wait",
        children: createElement(Outer, {}),
      }),
    );
    expect(container.textContent).toBe("inner-waits");

    // The inner boundary committed into the outer staging root, so its range
    // only settles once that root reaches the document; the retry uses it.
    settle("ready");
    await until(() => container.textContent === "readys");
    expect(calls).toEqual({ outer: 1, inner: 2, sibling: 1 });
  });

  it("updates a component in place once a retry has replaced the content", async () => {
    const calls = { app: 0, counter: 0 };
    let suspend = false;
    let settle!: () => void;
    let pending: Promise<void> | null = null;

    function Counter() {
      calls.counter++;
      const [count, setCount] = useState(0);
      if (suspend) {
        pending ??= new Promise<void>((resolve) => (settle = resolve));
        use(pending);
      }
      return createElement("button", {
        onClick: () => {
          suspend = true;
          setCount(count + 1);
        },
        children: "c" + count,
      });
    }
    function App() {
      calls.app++;
      return createElement("div", { children: createElement(Counter, {}) });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(App, {}),
      }),
    );
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("loading");

    settle();
    await until(() => container.textContent === "c1");

    // The retried content named the ranges its nodes now occupy, so this update
    // only re-renders the counter.
    suspend = false;
    const before = { ...calls };
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("c2");
    expect(calls).toEqual({ app: before.app, counter: before.counter + 1 });
  });

  it("updates a component inside a fallback in place", () => {
    const never = new Promise<never>(() => {});
    const calls = { fallback: 0 };

    function Never() {
      use(never);
      return null;
    }
    function Fallback() {
      calls.fallback++;
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "f" + count,
      });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: createElement(Fallback, {}),
        children: createElement(Never, {}),
      }),
    );
    expect(container.textContent).toBe("f0");

    click(container.childNodes[0]);
    expect(container.textContent).toBe("f1");
    expect(calls.fallback).toBe(2);
  });

  it("drops the ranges of an outer attempt that suspends after an inner boundary committed", async () => {
    const calls = { shell: 0, counter: 0 };
    let settle!: () => void;
    let pending: Promise<void> | null = null;
    let slow = false;

    function Slow() {
      pending ??= new Promise<void>((resolve) => (settle = resolve));
      use(pending);
      return null;
    }
    function Counter() {
      calls.counter++;
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "c" + count,
      });
    }
    function Shell() {
      calls.shell++;
      const [armed, setArmed] = useState(false);
      return createElement("div", {
        children: [
          createElement("button", {
            onClick: () => {
              slow = true;
              setArmed(true);
            },
            children: "arm",
          }),
          createElement(REACT_SUSPENSE_TYPE, {
            fallback: "inner-wait",
            children: createElement(Counter, {}),
          }),
          armed && slow ? createElement(Slow, {}) : null,
        ],
      });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "outer-wait",
        children: createElement(Shell, {}),
      }),
    );
    expect(container.textContent).toBe("armc0");

    // The inner boundary commits into the outer staging root and then the outer
    // attempt throws, so every range recorded in it must go with it.
    click(asElement(container.childNodes[0]).childNodes[0]);
    expect(container.textContent).toBe("outer-wait");

    slow = false;
    settle();
    await until(() => container.textContent === "armc0");

    const before = { ...calls };
    click(asElement(container.childNodes[0]).childNodes[1]);
    expect(container.textContent).toBe("armc1");
    expect(calls).toEqual({ shell: before.shell, counter: before.counter + 1 });
  });

  it("recovers from an update that wrote part of its output before suspending", async () => {
    let settle!: () => void;
    let gate: Promise<void> | null = null;
    let slow = false;

    function Slow() {
      gate ??= new Promise<void>((resolve) => (settle = resolve));
      use(gate);
      return null;
    }
    function Child() {
      const [count, setCount] = useState(0);
      const items: Any[] = [];
      for (let i = 0; i < count; i++) items.push(createElement("i", { children: String(i) }));
      if (slow) items.push(createElement(Slow, {}));
      return createElement("button", {
        onClick: () => {
          slow = true;
          setCount(count + 1);
        },
        children: items,
      });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(Child, {}),
      }),
    );
    expect(asElement(container.childNodes[0]).childNodes).toHaveLength(0);

    // The scoped pass places the first item and then throws; only a root pass can
    // put the boundary back on the stack, and the partial output must not leak.
    click(asElement(container.childNodes[0]));
    expect(container.textContent).toBe("loading");

    slow = false;
    settle();
    await until(() => container.textContent === "0");
    expect(container.childNodes).toHaveLength(1);
    expect(asElement(container.childNodes[0]).childNodes).toHaveLength(1);
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

  it("re-renders only the component whose state changed inside a boundary", () => {
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

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "loading",
        children: createElement(App, {}),
      }),
    );
    expect(calls).toEqual({ app: 1, counter: 1, sibling: 1 });

    // The content was staged, so its ranges settle when the boundary commits.
    click(asElement(container.childNodes[0]).childNodes[0]);

    expect(calls).toEqual({ app: 1, counter: 2, sibling: 1 });
    expect(container.textContent).toBe("c1s");
  });

  it("re-renders in place when the boundary is nested in another one", () => {
    const calls = { app: 0, counter: 0 };

    function Counter() {
      calls.counter++;
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "c" + count,
      });
    }
    function App() {
      calls.app++;
      return createElement("div", { children: createElement(Counter, {}) });
    }

    const container = mount(
      createElement(REACT_SUSPENSE_TYPE, {
        fallback: "outer",
        children: createElement(REACT_SUSPENSE_TYPE, {
          fallback: "inner",
          children: createElement(App, {}),
        }),
      }),
    );
    expect(calls).toEqual({ app: 1, counter: 1 });

    // The inner content commits into the outer boundary's staging root first, so
    // its ranges stay pending until that root reaches the document.
    click(asElement(container.childNodes[0]).childNodes[0]);

    expect(calls).toEqual({ app: 1, counter: 2 });
    expect(container.textContent).toBe("c1");
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
