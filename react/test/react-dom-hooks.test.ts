import { describe, expect, it } from "vitest";
import { createElement, useCallback, useMemo, useReducer, useRef, useState } from "../react.ts";
import type { Any } from "../shared.ts";
import { createRoot } from "../react-dom-client.ts";
import { renderToString } from "../react-dom-server.ts";
import { asElement, mount, TestDocument } from "./dom-shim.ts";

/** Dispatch a click on the first node of the container. */
function click(container: { childNodes: Any[] }): void {
  asElement(container.childNodes[0]).dispatch("click", {});
}

describe("useState", () => {
  it("mounts and updates", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount((previous) => previous + 1),
        children: "count: " + count,
      });
    }

    const container = mount(createElement(Counter, {}));
    expect(container.textContent).toBe("count: 0");
    click(container);
    expect(container.textContent).toBe("count: 1");
    click(container);
    expect(container.textContent).toBe("count: 2");
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

    const container = mount(createElement(Counter, {}));
    expect(container.textContent).toBe("10");
    expect(initializations).toBe(1);

    click(container);
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

    const container = mount(createElement(Pair, {}));
    const buttons = () => asElement(container.childNodes[0]).childNodes.map(asElement);
    expect(container.textContent).toBe("a0b100");

    buttons()[0].dispatch("click", {});
    expect(container.textContent).toBe("a1b100");

    buttons()[1].dispatch("click", {});
    expect(container.textContent).toBe("a1b101");
  });

  it("applies queued updates in order", () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => {
          setCount((previous) => previous + 1);
          setCount((previous) => previous + 1);
        },
        children: String(count),
      });
    }

    const container = mount(createElement(Counter, {}));
    click(container);
    expect(container.textContent).toBe("2");
  });

  it("returns the same updater function on every render", () => {
    const updaters: Any[] = [];
    function Counter() {
      const [count, setCount] = useState(0);
      updaters.push(setCount);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Counter, {}));
    click(container);
    expect(updaters).toHaveLength(2);
    expect(updaters[0]).toBe(updaters[1]);
  });

  it("does not throw when a state update lands after unmount", () => {
    let setCount!: (value: number) => void;
    function Counter() {
      const [count, update] = useState(0);
      setCount = update;
      return createElement("div", { children: String(count) });
    }

    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);
    root.render(createElement(Counter, {}));
    expect(container.textContent).toBe("0");

    root.unmount();
    expect(() => setCount(1)).not.toThrow();
    expect(container.textContent).toBe("");
  });
});

describe("useReducer", () => {
  it("dispatches actions", () => {
    function reducer(state: number, action: string): number {
      if (action === "inc") return state + 1;
      if (action === "reset") return 0;
      return state;
    }
    function Counter() {
      const [count, dispatch] = useReducer(reducer, 1);
      return createElement("button", {
        onClick: () => dispatch("inc"),
        children: String(count),
      });
    }

    const container = mount(createElement(Counter, {}));
    expect(container.textContent).toBe("1");
    click(container);
    expect(container.textContent).toBe("2");
  });

  it("supports an initializer function", () => {
    function reducer(state: number, action: string): number {
      return action === "inc" ? state + 1 : state;
    }
    function Init() {
      const [count] = useReducer(reducer, 5, (initial: number) => initial + 100);
      return createElement("div", { children: String(count) });
    }

    expect(renderToString(createElement(Init, {}))).toBe("<div>105</div>");
  });
});

describe("useRef", () => {
  it("keeps the same ref object across renders", () => {
    const seen: Any[] = [];
    function Comp() {
      const ref = useRef({ tag: "stable" });
      seen.push(ref);
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    click(container);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("keeps mutations across renders", () => {
    const values: number[] = [];
    function Comp() {
      const ref = useRef(0);
      const [count, setCount] = useState(0);
      values.push(ref.current);
      return createElement("button", {
        onClick: () => {
          ref.current++;
          setCount(count + 1);
        },
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    click(container);
    expect(values).toEqual([0, 1]);
  });
});

describe("useMemo", () => {
  it("recomputes only when a dependency changes", () => {
    let computations = 0;
    function Comp() {
      const [count, setCount] = useState(0);
      const doubled = useMemo(() => {
        computations++;
        return count * 2;
      }, [count]);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "n=" + count + ";2n=" + doubled,
      });
    }

    const container = mount(createElement(Comp, {}));
    expect(computations).toBe(1);
    expect(container.textContent).toBe("n=0;2n=0");

    click(container);
    expect(computations).toBe(2);
    expect(container.textContent).toBe("n=1;2n=2");
  });

  it("keeps the memoized value when dependencies are equal", () => {
    let computations = 0;
    function Comp() {
      const [count, setCount] = useState(0);
      useMemo(() => {
        computations++;
        return "constant";
      }, ["same"]);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    click(container);
    expect(computations).toBe(1);
    expect(container.textContent).toBe("1");
  });

  it("recomputes on every render without dependencies", () => {
    let computations = 0;
    function Comp() {
      const [count, setCount] = useState(0);
      useMemo(() => {
        computations++;
        return count;
      }, undefined);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    click(container);
    expect(computations).toBe(2);
  });
});

describe("useCallback", () => {
  it("keeps identity while dependencies are unchanged", () => {
    const seen: Any[] = [];
    function Comp() {
      const [count, setCount] = useState(0);
      const callback = useCallback(() => count, []);
      seen.push(callback);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    click(container);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("creates a new callback when a dependency changes", () => {
    const seen: Any[] = [];
    function Comp() {
      const [count, setCount] = useState(0);
      const callback = useCallback(() => count, [count]);
      seen.push(callback);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    click(container);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe("component state", () => {
  it("survives a parent re-render", () => {
    function Child() {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: "child:" + count,
      });
    }
    function Parent() {
      const [count, setCount] = useState(0);
      return createElement("div", {
        children: [
          createElement("span", {
            onClick: () => setCount(count + 1),
            children: "parent:" + count,
          }),
          createElement(Child, {}),
        ],
      });
    }

    const container = mount(createElement(Parent, {}));
    const div = () => asElement(container.childNodes[0]);
    const span = () => asElement(div().childNodes[0]);
    const button = () => asElement(div().childNodes[1]);

    expect(div().textContent).toBe("parent:0child:0");
    button().dispatch("click", {});
    expect(div().textContent).toBe("parent:0child:1");
    span().dispatch("click", {});
    expect(div().textContent).toBe("parent:1child:1");
  });

  it("is independent between siblings", () => {
    function Counter({ label }: { label: string }) {
      const [count, setCount] = useState(0);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: label + count,
      });
    }
    const container = mount(
      createElement("div", {
        children: [createElement(Counter, { label: "a" }), createElement(Counter, { label: "b" })],
      }),
    );
    const buttons = () => asElement(container.childNodes[0]).childNodes.map(asElement);

    buttons()[0].dispatch("click", {});
    expect(container.textContent).toBe("a1b0");
    buttons()[1].dispatch("click", {});
    expect(container.textContent).toBe("a1b1");
  });
});

describe("hook rules", () => {
  it("throws when a render uses fewer hooks than before", () => {
    function Comp() {
      const [count, setCount] = useState(0);
      if (count > 0) return createElement("b", { children: "done" });
      const [label] = useState("ready");
      return createElement("button", { onClick: () => setCount(1), children: label });
    }

    const container = mount(createElement(Comp, {}));
    expect(() => click(container)).toThrow("Rendered fewer hooks than expected");
  });

  it("throws when a hook is called outside a component", () => {
    expect(() => useState(0)).toThrow("Invalid hook call");
  });

  it("runs hooks as a one-shot mount in renderToString", () => {
    function Comp() {
      const [count] = useState(5);
      const ref = useRef("r");
      const doubled = useMemo(() => count * 2, [count]);
      return createElement("div", { children: count + ":" + ref.current + ":" + doubled });
    }

    expect(renderToString(createElement(Comp, {}))).toBe("<div>5:r:10</div>");
  });
});
