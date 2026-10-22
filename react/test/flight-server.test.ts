import { describe, expect, it } from "vitest";
import { createClientReference, createElement, createServerReference } from "../react.ts";
import { createFromReadableStream, deepAwait } from "../react-flight-client.ts";
import { renderToReadableStream } from "../react-flight-server.ts";
import { roundTrip } from "./helpers.ts";

/** Collect every byte the server writes, then close the reader. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value, { stream: true });
  }
}

describe("server rows", () => {
  it("writes the root model as row 0", async () => {
    expect(await readAll(renderToReadableStream({ hello: "world" }))).toBe('0:{"hello":"world"}\n');
  });

  it("encodes special values inline", async () => {
    const text = await readAll(
      renderToReadableStream({
        date: new Date("2026-10-13T00:00:00.000Z"),
        bigint: 1n,
        nan: NaN,
        infinite: Infinity,
        missing: undefined,
        symbol: Symbol.for("x"),
      }),
    );
    expect(text).toBe(
      '0:{"date":"$D2026-10-13T00:00:00.000Z","bigint":"$n1","nan":"$NaN",' +
        '"infinite":"$Infinity","missing":"$undefined","symbol":"$Sx"}\n',
    );
  });

  it("allocates ids in order but writes completed rows as soon as they exist", async () => {
    const Widget = createClientReference("./Widget.js", "Widget");
    const stream = renderToReadableStream({ child: createElement(Widget, {}) });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const rows: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rows.push(...decoder.decode(value, { stream: true }).split("\n").filter(Boolean));
    }

    // The import row was allocated second (id 1) but finished first, so it
    // reaches the client before the row that refers to it.
    expect(rows[0]).toBe('1:I{"id":"./Widget.js","name":"Widget"}');
    expect(rows[1]).toBe('0:{"child":["$","$L1",null,{}]}');
  });

  it("dedupes a shared thenable into one promise reference", async () => {
    const promise = Promise.resolve({ text: "shared" });
    const { value, rows } = await roundTrip({ a: promise, b: promise });

    expect(value.a).toBe(value.b);
    expect(rows.filter((row) => row.includes('"$@'))).toHaveLength(1);
    expect(rows[0]).toContain('"a":"$@1"');
    expect(rows[0]).toContain('"b":"$@1"');
  });

  it("writes client reference metadata as an I row", async () => {
    const Widget = createClientReference("./Widget.js", "Widget");
    const stream = renderToReadableStream({ Widget });
    const rows = (await readAll(stream)).split("\n").filter(Boolean);

    expect(rows[0]).toBe('1:I{"id":"./Widget.js","name":"Widget"}');
  });

  it("writes server reference metadata as a model row", async () => {
    const action = createServerReference("./action.js#doThing");
    const text = await readAll(renderToReadableStream({ action }));

    expect(text).toBe('1:{"id":"./action.js#doThing"}\n0:{"action":"$h1"}\n');
  });

  it("closes the stream after the last row", async () => {
    const reader = renderToReadableStream([1, 2, 3]).getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join("")).toBe("0:[1,2,3]\n");
    expect(chunks.join("").endsWith("\n")).toBe(true);
  });

  it("encodes the stream as UTF-8", async () => {
    const text = "服务器 → 客户端 🚀";
    const { value } = await roundTrip({ text });
    expect(value.text).toBe(text);
    expect(await readAll(renderToReadableStream({ text }))).toContain(text);
  });
});

describe("server errors", () => {
  it("writes an E row and points the model at it", async () => {
    function Boom() {
      throw new Error("component boom");
    }
    const stream = renderToReadableStream({ b: createElement(Boom, {}) });
    const rows = (await readAll(stream)).split("\n").filter(Boolean);

    expect(rows[0]).toBe('1:E{"digest":"","message":"component boom","name":"Error"}');
    expect(rows[1]).toBe('0:{"b":"$1"}');
  });

  it("rejects a plain function passed as a value", async () => {
    await expect(roundTrip({ fn() {} })).rejects.toThrow(
      'Functions cannot be passed to Client Components unless marked with "use server".',
    );
  });

  it("rejects class instances", async () => {
    class NotSerializable {
      value = 1;
    }
    await expect(roundTrip({ instance: new NotSerializable() })).rejects.toThrow(
      "Unsupported object type in RSC payload.",
    );
  });

  it("rejects symbols that are not registered", async () => {
    await expect(roundTrip({ symbol: Symbol("local") })).rejects.toThrow(
      "Only Symbol.for(...) symbols can be serialized.",
    );
  });

  it("rejects a component that throws during rendering", async () => {
    function Boom() {
      throw new Error("render failed");
    }
    const root = createFromReadableStream(renderToReadableStream(createElement(Boom, {})));
    await expect((async () => deepAwait(await root))()).rejects.toThrow("render failed");
  });
});
