/**
 * `createRoot` walks the tree in `react-dom-core.ts`; `createFiberDomRoot`
 * reconciles fibers in `react-fiber.ts`. They are two clients behind one
 * interface, so every case here renders the same element through both and
 * compares the document they leave behind.
 */
import { describe, expect, it } from "vitest";
import {
  REACT_FRAGMENT_TYPE,
  REACT_SUSPENSE_TYPE,
  createElement,
  use,
  useEffect,
  useLayoutEffect,
  useState,
} from "../react.ts";
import type { Any } from "../shared.ts";
import { createFiberDomRoot, createRoot, type ReactDomRoot } from "../react-dom-client.ts";
import {
  asElement,
  mount,
  TestDocument,
  TestElement,
  type RootFactory,
  TestNode,
  TestText,
} from "./dom-shim.ts";
import { delay, until } from "./helpers.ts";

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

describe("client parity", () => {
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
      asElement(container.childNodes[0]).dispatch("click", {});
      asElement(container.childNodes[0]).dispatch("click", {});
      return shape(container);
    };

    const walker = run(createRoot);
    expect(walker).toBe('<root><button>"2"</button></root>');
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
      let settle!: (value: string) => void;
      const data = new Promise<string>((resolve) => (settle = resolve));

      function Show() {
        return createElement("b", { children: use(data) });
      }

      const container = mount(
        createElement(REACT_SUSPENSE_TYPE, {
          fallback: "loading",
          children: createElement(Show, {}),
        }),
        create,
      );
      const fallback = shape(container);

      settle("ready");
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
