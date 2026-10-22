import { describe, expect, it, vi } from "vitest";
import { REACT_LAZY_TYPE } from "../react.ts";
import { Chunk, createFromReadableStream, deepAwait } from "../react-flight-client.ts";
import type { Any } from "../shared.ts";
import { gate, withTimeout } from "./helpers.ts";

/** A stream whose rows can be released one at a time. */
function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push(text: string): void {
      controller.enqueue(encoder.encode(text));
    },
    close(): void {
      controller.close();
    },
    error(reason: Any): void {
      controller.error(reason);
    },
  };
}

describe("incremental reading", () => {
  it("buffers a row that arrives in pieces", async () => {
    const rows: string[] = [];
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream, { onRow: (row) => rows.push(row) });

    push('0:{"a":');
    push("1}");
    close();

    await expect(withTimeout(root, 500)).resolves.toEqual({ a: 1 });
    expect(rows).toEqual(['0:{"a":1}']);
  });

  it("flushes a trailing row that has no newline when the stream ends", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push('0:{"a":1}');
    close();

    await expect(withTimeout(root, 500)).resolves.toEqual({ a: 1 });
  });

  it("parses several rows delivered in one chunk", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream, {
      clientModules: { "./C.js": { C: () => null } },
    });

    push('1:I{"id":"./C.js","name":"C"}\n0:{"v":"$L1"}\n');
    close();

    const value = await deepAwait(await root);
    expect(typeof value.v).toBe("function");
  });
});

describe("pending references", () => {
  it("resolves the root before a later row arrives", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push('0:{"ready":"now","later":"$@1"}\n');
    const value = await withTimeout(root, 500);

    expect(value.ready).toBe("now");
    expect(value.later).toBeInstanceOf(Chunk);
    expect((value.later as Chunk).status).toBe("pending");

    push('1:{"done":true}\n');
    close();
    await expect(value.later).resolves.toEqual({ done: true });
  });

  it("keeps a lazy reference pending until its row lands", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push('0:{"child":"$L1"}\n');
    const value = await withTimeout(root, 500);

    expect(value.child.$$typeof).toBe(REACT_LAZY_TYPE);
    expect(() => value.child._init()).toThrow();

    push('1:["$","p",null,{"children":"hi"}]\n');
    close();

    const settled = await deepAwait(value);
    expect(settled.child.type).toBe("p");
    expect(settled.child.props.children).toBe("hi");
  });

  it("rejects chunks that are still waiting when the stream errors", async () => {
    const { stream, push, error } = controlledStream();
    const root = createFromReadableStream(stream);

    push('0:{"p":"$@1"}\n');
    const value = await withTimeout(root, 500);
    const pending = value.p as Chunk;

    error(new Error("network"));
    await expect(pending).rejects.toThrow("network");
  });
});

describe("client modules", () => {
  it("resolves an I row used as an element type", async () => {
    const Widget = (props: Any) => props;
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream, {
      clientModules: { "./Widget.js": { Widget } },
    });

    push('1:I{"id":"./Widget.js","name":"Widget"}\n0:{"el":["$","$L1",null,{}]}\n');
    close();

    const value = await deepAwait(await root);
    expect(value.el.type).toBe(Widget);
  });

  it("suspends on an asynchronously resolved module", async () => {
    const Widget = (props: Any) => props;
    const resolveClientComponent = vi.fn((meta: { id: string; name: string }) => {
      expect(meta).toEqual({ id: "./Widget.js", name: "Widget" });
      return gate(10, Widget);
    });
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream, { resolveClientComponent });

    push('1:I{"id":"./Widget.js","name":"Widget"}\n0:{"el":["$","$L1",null,{}]}\n');
    const value = await withTimeout(root, 500);

    expect(() => value.el.type._init()).toThrow();
    close();

    const settled = await deepAwait(value);
    expect(settled.el.type).toBe(Widget);
    expect(resolveClientComponent).toHaveBeenCalledTimes(1);
  });

  it("resolves a by-value reference to the metadata marker", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream, {
      clientModules: { "./Widget.js": { Widget: () => null } },
    });

    push('1:I{"id":"./Widget.js","name":"Widget"}\n0:{"ref":"$1"}\n');
    close();

    const value = await deepAwait(await root);
    expect(value.ref.id).toBe("./Widget.js");
    expect(value.ref.name).toBe("Widget");
  });

  it("reports a missing module only when the component is read", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push('0:{"el":["$","$L1",null,{}]}\n1:I{"id":"./Missing.js","name":"Missing"}\n');
    close();

    const value = await withTimeout(root, 500);
    await expect(deepAwait(value)).rejects.toThrow("Could not resolve the client reference");
  });
});

describe("server errors", () => {
  it("turns an E row into a server error", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push('1:E{"digest":"","message":"boom","name":"Error"}\n0:"$1"\n');
    close();

    await expect(withTimeout(root, 500)).rejects.toThrow("Server error: boom");
  });
});

describe("text rows", () => {
  it("reads a T row as raw text", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push("0:T5,hello\n");
    close();

    await expect(withTimeout(root, 500)).resolves.toBe("hello");
  });
});

describe("rendering a streamed model", () => {
  it("lets the root be used while a lazy child is still pending", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push('0:{"children":["$","div",null,{"children":"$L1"}]}\n');
    const value = await withTimeout(root, 500);
    expect(value.children.props.children.$$typeof).toBe(REACT_LAZY_TYPE);

    push('1:["$","span",null,{"children":"later"}]\n');
    close();

    const settled = await deepAwait(value);
    expect(settled.children.props.children.type).toBe("span");
  });

  it("renders an element delivered as its own row", async () => {
    const { stream, push, close } = controlledStream();
    const root = createFromReadableStream(stream);

    push('0:["$","div",null,{"children":["$","span",null,{"children":"hi"}]}]\n');
    close();

    const value = await deepAwait(await root);
    expect(value.type).toBe("div");
    expect(value.props.children.type).toBe("span");
  });
});
