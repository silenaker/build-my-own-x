import { describe, expect, it } from "vitest";
import { createClientReference, createElement, use, useState } from "../react.ts";
import type { Any } from "../shared.ts";
import { createRoot } from "../react-dom-client.ts";
import { renderToString } from "../react-dom-server.ts";
import { createFromReadableStream, deepAwait } from "../react-flight-client.ts";
import { renderToReadableStream } from "../react-flight-server.ts";
import { sleep } from "./helpers.ts";
import { asElement, TestDocument } from "./dom-shim.ts";

const Counter = createClientReference("./Counter.js", "Counter");

/** A renderable tree: a client component plus a suspending server component. */
function createApp(slowMs: number): Any {
  const slow = sleep(slowMs, { text: "server data" });

  function Slow() {
    const data = use<{ text: string }>(slow);
    return createElement("p", { children: data.text });
  }
  function App() {
    return createElement("div", {
      className: "app",
      children: [
        createElement("h1", { children: "Hello RSC" }),
        createElement(Counter, { initial: 3 }),
        createElement(Slow, {}),
        createElement("footer", { children: "bye" }),
      ],
    });
  }
  return createElement(App, {});
}

const clientModules = {
  "./Counter.js": {
    Counter: (props: { initial: number }) =>
      createElement("button", { children: "count: " + props.initial }),
  },
};

const EXPECTED =
  '<div class="app"><h1>Hello RSC</h1><button>count: 3</button><p>server data</p><footer>bye</footer></div>';

async function renderFlight(
  slowMs: number,
  options: Parameters<typeof createFromReadableStream>[1] = { clientModules },
): Promise<Any> {
  const stream = renderToReadableStream(createApp(slowMs));
  return deepAwait(await createFromReadableStream(stream, options));
}

describe("flight to HTML", () => {
  it("renders a suspended server component tree", async () => {
    expect(renderToString(await renderFlight(15))).toBe(EXPECTED);
  });

  it("renders without suspension", async () => {
    expect(renderToString(await renderFlight(0))).toBe(EXPECTED);
  });

  it("resolves client modules asynchronously", async () => {
    const tree = await renderFlight(0, {
      resolveClientComponent: async (meta) => {
        expect(meta.id).toBe("./Counter.js");
        await sleep(5, null);
        return clientModules["./Counter.js"].Counter;
      },
    });
    expect(renderToString(tree)).toBe(EXPECTED);
  });

  it("passes serialized props to the client component", async () => {
    const shared = { role: "admin" };
    const Widget = createClientReference("./Widget.js", "Widget");

    function App() {
      return createElement("div", {
        children: createElement(Widget, { config: shared, other: shared }),
      });
    }

    const tree = await deepAwait(
      await createFromReadableStream(renderToReadableStream(createElement(App, {})), {
        clientModules: {
          "./Widget.js": {
            Widget: (props: Any) =>
              createElement("b", {
                children: props.config.role + ":" + String(props.config === props.other),
              }),
          },
        },
      }),
    );
    expect(renderToString(tree)).toBe("<div><b>admin:true</b></div>");
  });
});

describe("flight to the DOM", () => {
  it("mounts the streamed tree", async () => {
    const document = new TestDocument();
    const container = document.createElement("root");
    createRoot(container as unknown as Element).render(await renderFlight(15));

    expect(container.textContent).toBe("Hello RSCcount: 3server databye");
    const div = asElement(container.childNodes[0]);
    expect(div.getAttribute("class")).toBe("app");
    expect(asElement(div.childNodes[1]).tagName).toBe("button");
  });

  it("lets a resolved client component use hooks", async () => {
    const hookClientModules = {
      "./Counter.js": {
        Counter: (props: { initial: number }) => {
          const [count, setCount] = useState(props.initial);
          return createElement("button", {
            onClick: () => setCount(count + 1),
            children: "count: " + count,
          });
        },
      },
    };

    const document = new TestDocument();
    const container = document.createElement("root");
    createRoot(container as unknown as Element).render(
      await renderFlight(0, { clientModules: hookClientModules }),
    );

    const button = () => asElement(asElement(container.childNodes[0]).childNodes[1]);
    expect(button().textContent).toBe("count: 3");
    button().dispatch("click", {});
    expect(button().textContent).toBe("count: 4");
  });
});
