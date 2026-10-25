import { describe, expect, it } from "vitest";
import { Suspense, createElement, use, useEffect, useLayoutEffect, useState } from "../react.ts";
import type { Any } from "../shared.ts";
import { createRoot } from "../react-dom-client.ts";
import { renderToString } from "../react-dom-server.ts";
import { asElement, mount, TestDocument } from "./dom-shim.ts";

/** Let the passive phase run, including a retry that settles on its own microtask. */
const flushEffects = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/** Dispatch a click on the first node of the container. */
function click(container: { childNodes: Any[] }): void {
  asElement(container.childNodes[0]).dispatch("click", {});
}

describe("useLayoutEffect", () => {
  it("runs before the render returns", () => {
    const log: string[] = [];
    function Comp() {
      useLayoutEffect(() => {
        log.push("layout");
      }, []);
      return createElement("div", { children: "hi" });
    }

    mount(createElement(Comp, {}));
    expect(log).toEqual(["layout"]);
  });

  it("reads the tree the commit already placed", () => {
    const seen: string[] = [];
    const document = new TestDocument();
    const container = document.createElement("root");

    function Comp() {
      useLayoutEffect(() => {
        seen.push(container.textContent);
      }, []);
      return createElement("div", { children: "committed" });
    }

    createRoot(container as unknown as Element).render(createElement(Comp, {}));
    expect(seen).toEqual(["committed"]);
  });

  it("commits an update it dispatches before the render returns", () => {
    function Comp() {
      const [value, setValue] = useState("before");
      useLayoutEffect(() => {
        setValue("after");
      }, []);
      return createElement("div", { children: value });
    }

    const container = mount(createElement(Comp, {}));
    expect(container.textContent).toBe("after");
  });
});

describe("useEffect", () => {
  it("waits for the commit to finish", async () => {
    const log: string[] = [];
    function Comp() {
      useLayoutEffect(() => {
        log.push("layout");
      }, []);
      useEffect(() => {
        log.push("passive");
      }, []);
      return createElement("div", { children: "hi" });
    }

    mount(createElement(Comp, {}));
    expect(log).toEqual(["layout"]);

    await flushEffects();
    expect(log).toEqual(["layout", "passive"]);
  });

  it("runs after every render without deps", async () => {
    let runs = 0;
    function Comp() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        runs++;
      });
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    expect(runs).toBe(0);
    await flushEffects();
    expect(runs).toBe(1);

    click(container);
    await flushEffects();
    expect(runs).toBe(2);
  });

  it("settles an update it dispatches", async () => {
    function Comp() {
      const [value, setValue] = useState("before");
      useEffect(() => {
        setValue("after");
      }, []);
      return createElement("div", { children: value });
    }

    const container = mount(createElement(Comp, {}));
    expect(container.textContent).toBe("before");

    await flushEffects();
    expect(container.textContent).toBe("after");
  });
});

describe("effect deps", () => {
  it("re-runs only when a dependency changes", async () => {
    const runs: number[] = [];
    function Comp() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        runs.push(count);
      }, [count]);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    await flushEffects();
    expect(runs).toEqual([0]);

    click(container);
    await flushEffects();
    expect(runs).toEqual([0, 1]);
  });

  it("leaves the effect alone while the deps stay equal", async () => {
    let runs = 0;
    function Comp() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        runs++;
      }, ["constant"]);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    await flushEffects();
    click(container);
    await flushEffects();

    expect(runs).toBe(1);
  });

  it("keeps sibling effects on their own deps", async () => {
    const runs: string[] = [];
    function Comp() {
      const [a, setA] = useState(0);
      const [b, setB] = useState(0);
      useEffect(() => {
        runs.push("a" + a);
      }, [a]);
      useEffect(() => {
        runs.push("b" + b);
      }, [b]);
      return createElement("div", {
        children: [
          createElement("button", { onClick: () => setA(a + 1), children: "a" }),
          createElement("button", { onClick: () => setB(b + 1), children: "b" }),
        ],
      });
    }

    const container = mount(createElement(Comp, {}));
    await flushEffects();

    const buttons = () => asElement(container.childNodes[0]).childNodes.map(asElement);
    buttons()[0].dispatch("click", {});
    await flushEffects();

    expect(runs).toEqual(["a0", "b0", "a1"]);
  });
});

describe("effect cleanup", () => {
  it("runs the previous cleanup before the next effect", async () => {
    const log: string[] = [];
    function Comp() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        log.push("effect " + count);
        return () => log.push("cleanup " + count);
      }, [count]);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const container = mount(createElement(Comp, {}));
    await flushEffects();
    expect(log).toEqual(["effect 0"]);

    click(container);
    await flushEffects();
    expect(log).toEqual(["effect 0", "cleanup 0", "effect 1"]);
  });

  it("cleans up on unmount", async () => {
    const log: string[] = [];
    const document = new TestDocument();
    const container = document.createElement("root");

    function Comp() {
      useEffect(() => {
        log.push("effect");
        return () => log.push("cleanup");
      }, []);
      return createElement("div", { children: "mounted" });
    }

    const root = createRoot(container as unknown as Element);
    root.render(createElement(Comp, {}));
    await flushEffects();
    expect(log).toEqual(["effect"]);

    root.unmount();
    expect(log).toEqual(["effect", "cleanup"]);
  });

  it("cleans up a layout effect synchronously on unmount", () => {
    const log: string[] = [];
    const document = new TestDocument();
    const container = document.createElement("root");

    function Comp() {
      useLayoutEffect(() => {
        log.push("effect");
        return () => log.push("cleanup");
      }, []);
      return createElement("div", { children: "mounted" });
    }

    const root = createRoot(container as unknown as Element);
    root.render(createElement(Comp, {}));
    expect(log).toEqual(["effect"]);

    root.unmount();
    expect(log).toEqual(["effect", "cleanup"]);
  });

  it("cleans up when a later render drops the component", async () => {
    const log: string[] = [];
    function Child() {
      useEffect(() => {
        log.push("effect");
        return () => log.push("cleanup");
      }, []);
      return createElement("span", { children: "child" });
    }
    function App({ show }: { show: boolean }) {
      return createElement("div", { children: show ? createElement(Child, {}) : "gone" });
    }

    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);
    root.render(createElement(App, { show: true }));
    await flushEffects();
    expect(log).toEqual(["effect"]);

    root.render(createElement(App, { show: false }));
    await flushEffects();
    expect(log).toEqual(["effect", "cleanup"]);
    expect(container.textContent).toBe("gone");
  });
});

describe("effects on an in-place update", () => {
  it("runs the effects of a child the update mounts", async () => {
    const log: string[] = [];
    function Child() {
      useLayoutEffect(() => {
        log.push("layout");
      }, []);
      useEffect(() => {
        log.push("passive");
      }, []);
      return createElement("span", { children: "child" });
    }
    function App() {
      const [show, setShow] = useState(false);
      return createElement("button", {
        onClick: () => setShow(true),
        children: show ? createElement(Child, {}) : "none",
      });
    }

    const container = mount(createElement(App, {}));
    await flushEffects();
    expect(log).toEqual([]);

    // The click re-renders App alone; the root is not walked again.
    click(container);
    expect(log).toEqual(["layout"]);

    await flushEffects();
    expect(log).toEqual(["layout", "passive"]);
  });

  it("cleans up a child the update drops", async () => {
    const log: string[] = [];
    function Child() {
      useEffect(() => {
        log.push("effect");
        return () => log.push("cleanup");
      }, []);
      return createElement("span", { children: "child" });
    }
    function App() {
      const [show, setShow] = useState(true);
      return createElement("button", {
        onClick: () => setShow(!show),
        children: show ? createElement(Child, {}) : "none",
      });
    }

    const container = mount(createElement(App, {}));
    await flushEffects();
    expect(log).toEqual(["effect"]);

    click(container);
    await flushEffects();
    expect(log).toEqual(["effect", "cleanup"]);
    expect(container.textContent).toBe("none");
  });
});

describe("effect order", () => {
  it("runs a child's effects before its parent's", async () => {
    const log: string[] = [];
    function Child() {
      useLayoutEffect(() => {
        log.push("child layout");
      }, []);
      useEffect(() => {
        log.push("child passive");
      }, []);
      return createElement("span", {});
    }
    function Parent() {
      useLayoutEffect(() => {
        log.push("parent layout");
      }, []);
      useEffect(() => {
        log.push("parent passive");
      }, []);
      return createElement("div", { children: createElement(Child, {}) });
    }

    mount(createElement(Parent, {}));
    expect(log).toEqual(["child layout", "parent layout"]);

    await flushEffects();
    expect(log).toEqual(["child layout", "parent layout", "child passive", "parent passive"]);
  });

  it("keeps the declaration order inside one component", async () => {
    const log: string[] = [];
    function Comp() {
      useEffect(() => {
        log.push("first");
      }, []);
      useEffect(() => {
        log.push("second");
      }, []);
      return createElement("div", {});
    }

    mount(createElement(Comp, {}));
    await flushEffects();
    expect(log).toEqual(["first", "second"]);
  });

  it("drops every effect of the phase before it runs any of them", () => {
    const log: string[] = [];
    function Child({ value }: { value: number }) {
      useLayoutEffect(() => {
        log.push("child " + value);
        return () => log.push("child cleanup " + value);
      }, [value]);
      return createElement("span", { children: String(value) });
    }
    function Parent({ value }: { value: number }) {
      useLayoutEffect(() => {
        log.push("parent " + value);
        return () => log.push("parent cleanup " + value);
      }, [value]);
      return createElement("div", { children: createElement(Child, { value }) });
    }

    const document = new TestDocument();
    const container = document.createElement("root");
    const root = createRoot(container as unknown as Element);
    root.render(createElement(Parent, { value: 0 }));
    expect(log).toEqual(["child 0", "parent 0"]);

    root.render(createElement(Parent, { value: 1 }));
    expect(log).toEqual([
      "child 0",
      "parent 0",
      "child cleanup 0",
      "parent cleanup 0",
      "child 1",
      "parent 1",
    ]);
  });

  it("finishes a pending passive phase before the next render", async () => {
    const log: string[] = [];
    const document = new TestDocument();
    const container = document.createElement("root");

    function App() {
      const [count, setCount] = useState(0);
      useEffect(() => {
        log.push("effect " + count + " sees " + container.textContent);
      }, [count]);
      return createElement("button", {
        onClick: () => setCount(count + 1),
        children: String(count),
      });
    }

    const root = createRoot(container as unknown as Element);
    root.render(createElement(App, {}));

    // The click lands before the passive phase of the mount has run.
    asElement(container.childNodes[0]).dispatch("click", {});
    expect(log).toEqual(["effect 0 sees 0"]);

    await flushEffects();
    expect(log).toEqual(["effect 0 sees 0", "effect 1 sees 1"]);
  });
});

describe("effects on other targets", () => {
  it("never runs effects while serializing", async () => {
    let runs = 0;
    function Comp() {
      useEffect(() => {
        runs++;
      }, []);
      useLayoutEffect(() => {
        runs++;
      }, []);
      return createElement("div", { children: "server" });
    }

    expect(renderToString(createElement(Comp, {}))).toBe("<div>server</div>");
    await flushEffects();
    expect(runs).toBe(0);
  });

  it("runs an effect once the boundary content commits", async () => {
    let resolve!: (value: string) => void;
    const promise = new Promise<string>((settle) => {
      resolve = settle;
    });
    const runs: string[] = [];

    function Content() {
      const value = use(promise);
      useEffect(() => {
        runs.push(value);
      }, [value]);
      return createElement("div", { children: value });
    }

    const container = mount(
      createElement(Suspense, {
        fallback: createElement("p", { children: "wait" }),
        children: createElement(Content, {}),
      }),
    );
    await flushEffects();
    expect(runs).toEqual([]);
    expect(container.textContent).toBe("wait");

    resolve("ready");
    await flushEffects();
    expect(runs).toEqual(["ready"]);
    expect(container.textContent).toBe("ready");
  });
});
