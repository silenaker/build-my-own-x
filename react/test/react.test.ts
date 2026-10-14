import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_REFERENCE,
  REACT_ELEMENT_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_SUSPENSE_TYPE,
  SERVER_REFERENCE,
  clientReferenceMeta,
  clientReferenceValue,
  createClientReference,
  createElement,
  createServerReference,
  isClientReference,
  isLazyWrapper,
  isServerReference,
  isValidElement,
  lazy,
  serverReferenceMeta,
  serverReferenceValue,
  use,
} from "../react.ts";
import type { Any } from "../shared.ts";

describe("createElement", () => {
  it("builds an element tuple", () => {
    expect(createElement("div", { id: "a" })).toEqual({
      $$typeof: REACT_ELEMENT_TYPE,
      type: "div",
      key: null,
      props: { id: "a" },
    });
  });

  it("defaults missing props to an empty object", () => {
    expect(createElement("div", null).props).toEqual({});
  });

  it("keeps an explicit key", () => {
    expect(createElement("li", null, "k1").key).toBe("k1");
  });
});

describe("isValidElement", () => {
  it("accepts elements and rejects everything else", () => {
    expect(isValidElement(createElement("div", null))).toBe(true);
    expect(isValidElement(null)).toBe(false);
    expect(isValidElement(undefined)).toBe(false);
    expect(isValidElement("div")).toBe(false);
    expect(isValidElement({})).toBe(false);
  });
});

describe("built-in types", () => {
  it("exposes Fragment and Suspense as registered symbols", () => {
    expect(REACT_FRAGMENT_TYPE).toBe(Symbol.for("react.fragment"));
    expect(REACT_SUSPENSE_TYPE).toBe(Symbol.for("react.suspense"));
  });
});

describe("client references", () => {
  it("cannot be called on the server", () => {
    const Counter = createClientReference("./Counter.js", "Counter");
    expect(() => (Counter as Any)()).toThrow(
      "A client reference cannot be called on the server: ./Counter.js#Counter",
    );
  });

  it("is identified by the marker, including decoded objects", () => {
    const Counter = createClientReference("./Counter.js", "Counter");
    expect(isClientReference(Counter)).toBe(true);
    expect(isClientReference(clientReferenceValue({ id: "./Counter.js", name: "Counter" }))).toBe(
      true,
    );
    expect(isClientReference({})).toBe(false);
    expect(isClientReference(null)).toBe(false);
  });

  it("exposes its metadata from the function and from the decoded value", () => {
    const Counter = createClientReference("./Counter.js", "Counter");
    expect(clientReferenceMeta(Counter)).toEqual({ id: "./Counter.js", name: "Counter" });
    expect(clientReferenceMeta(clientReferenceValue(clientReferenceMeta(Counter)))).toEqual({
      id: "./Counter.js",
      name: "Counter",
    });
  });

  it("decodes into the tagged metadata object", () => {
    expect(clientReferenceValue({ id: "./Counter.js", name: "Counter" })).toEqual({
      $$typeof: CLIENT_REFERENCE,
      id: "./Counter.js",
      name: "Counter",
    });
  });
});

describe("server references", () => {
  it("cannot be called on the server", () => {
    const action = createServerReference("./action.js#doThing");
    expect(() => (action as Any)()).toThrow(
      "A server reference cannot be called on the server: ./action.js#doThing",
    );
  });

  it("exposes its metadata", () => {
    const action = createServerReference("./action.js#doThing");
    expect(isServerReference(action)).toBe(true);
    expect(isServerReference(serverReferenceValue("./action.js#doThing"))).toBe(true);
    expect(serverReferenceMeta(action)).toEqual({ id: "./action.js#doThing" });
    expect(serverReferenceMeta(serverReferenceValue("x"))).toEqual({ id: "x" });
  });

  it("decodes into the tagged metadata object", () => {
    expect(serverReferenceValue("./action.js#doThing")).toEqual({
      $$typeof: SERVER_REFERENCE,
      id: "./action.js#doThing",
    });
  });
});

describe("lazy", () => {
  it("suspends on the first read and then returns the default export", async () => {
    const Widget = (props: Any) => props;
    const load = vi.fn(async () => ({ default: Widget }));
    const Lazy = lazy(load);

    expect(isLazyWrapper(Lazy)).toBe(true);
    expect(Lazy.$$typeof).toBe(REACT_LAZY_TYPE);

    let thrown: Any;
    try {
      Lazy._init();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Promise);

    await thrown;
    expect(Lazy._init()).toBe(Widget);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("calls the loader only once even when read repeatedly", async () => {
    const load = vi.fn(async () => ({ default: () => null }));
    const Lazy = lazy(load);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        Lazy._init();
      } catch (error) {
        await error;
      }
    }
    Lazy._init();
    Lazy._init();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("use", () => {
  it("returns the value of a fulfilled thenable", () => {
    expect(use({ status: "fulfilled", value: "done", then() {} } as Any)).toBe("done");
  });

  it("rethrows the reason of a rejected thenable", () => {
    const reason = new Error("boom");
    expect(() => use({ status: "rejected", reason, then() {} } as Any)).toThrow("boom");
  });

  it("throws the thenable itself while it is pending, and instruments it", async () => {
    const promise: Any = Promise.resolve("later");
    expect(() => use(promise)).toThrow();
    expect(promise.status).toBe("pending");

    await promise;
    expect(promise.status).toBe("fulfilled");
    expect(promise.value).toBe("later");
    expect(use(promise)).toBe("later");
  });

  it("instruments rejection once the thenable settles", async () => {
    const reason = new Error("nope");
    const promise: Any = Promise.reject(reason);
    promise.catch(() => {});

    expect(() => use(promise)).toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(promise.status).toBe("rejected");
    expect(promise.reason).toBe(reason);
    expect(() => use(promise)).toThrow("nope");
  });
});
