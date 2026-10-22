import { describe, expect, it } from "vitest";
import {
  NOT_A_PRIMITIVE,
  SERIALIZED_UNDEFINED,
  decodePrimitive,
  encodeRow,
  parseReference,
  parseRow,
  serializeBigInt,
  serializeByValueID,
  serializeDate,
  serializeLazyID,
  serializeNumber,
  serializePromiseID,
  serializeServerReferenceID,
  serializeString,
  serializeSymbol,
  splitRows,
} from "../react-flight-protocol.ts";
import { REACT_ELEMENT_TYPE, SERVER_REFERENCE } from "../react.ts";

describe("wire rows", () => {
  it("parses a default model row", () => {
    expect(parseRow('0:{"name":"root"}')).toEqual({
      id: 0,
      tag: "",
      payload: { name: "root" },
    });
  });

  it("reads the row id as hexadecimal", () => {
    expect(parseRow("1f:1").id).toBe(31);
  });

  it("parses an import metadata row", () => {
    expect(parseRow('1:I{"id":"./Counter.js","name":"Counter"}')).toEqual({
      id: 1,
      tag: "I",
      payload: { id: "./Counter.js", name: "Counter" },
    });
  });

  it("parses an error row", () => {
    expect(parseRow('2:E{"digest":"","message":"boom","name":"Error"}')).toEqual({
      id: 2,
      tag: "E",
      payload: { digest: "", message: "boom", name: "Error" },
    });
  });

  it("parses a length-prefixed text row without JSON", () => {
    expect(parseRow("3:T5,hello")).toEqual({ id: 3, tag: "", payload: "hello" });
  });

  it("encodes a row as hex id, tag, payload and a newline", () => {
    expect(encodeRow(10, "I", "{}")).toBe("a:I{}\n");
    expect(encodeRow(0, "", "null")).toBe("0:null\n");
  });

  it("round-trips a row through encodeRow and parseRow", () => {
    const row = encodeRow(31, "", '{"ok":true}').slice(0, -1);
    expect(parseRow(row)).toEqual({ id: 31, tag: "", payload: { ok: true } });
  });
});

describe("splitRows", () => {
  it("splits complete rows and keeps the trailing partial row", () => {
    expect(splitRows("0:a\n1:b\n2:par")).toEqual({ rows: ["0:a", "1:b"], rest: "2:par" });
  });

  it("treats a buffer without a newline as one partial row", () => {
    expect(splitRows("0:partial")).toEqual({ rows: [], rest: "0:partial" });
  });
});

describe("reference ids", () => {
  it("encodes every reference kind with its tag", () => {
    expect(serializeByValueID(31)).toBe("$1f");
    expect(serializeLazyID(31)).toBe("$L1f");
    expect(serializePromiseID(31)).toBe("$@1f");
    expect(serializeServerReferenceID(31)).toBe("$h1f");
  });
});

describe("serializing values JSON cannot express", () => {
  it("escapes strings that start with a dollar sign", () => {
    expect(serializeString("hello")).toBe("hello");
    expect(serializeString("$0")).toBe("$$0");
    expect(serializeString("$")).toBe("$$");
    expect(serializeString("$$x")).toBe("$$$x");
  });

  it("spells out special numbers", () => {
    expect(serializeNumber(42)).toBe(42);
    expect(serializeNumber(3.5)).toBe(3.5);
    expect(serializeNumber(-0)).toBe("$-0");
    expect(serializeNumber(Infinity)).toBe("$Infinity");
    expect(serializeNumber(-Infinity)).toBe("$-Infinity");
    expect(serializeNumber(NaN)).toBe("$NaN");
  });

  it("encodes bigint, registered symbols and dates", () => {
    expect(serializeBigInt(123n)).toBe("$n123");
    expect(serializeSymbol(Symbol.for("test.sym"))).toBe("$Stest.sym");
    expect(serializeDate(new Date("2026-10-13T00:00:00.000Z"))).toBe("$D2026-10-13T00:00:00.000Z");
  });
});

describe("decodePrimitive", () => {
  it("returns ordinary strings unchanged", () => {
    expect(decodePrimitive("hello")).toBe("hello");
    expect(decodePrimitive("")).toBe("");
  });

  it("decodes the element-type marker", () => {
    expect(decodePrimitive("$")).toBe(REACT_ELEMENT_TYPE);
  });

  it("decodes escaped dollar strings", () => {
    expect(decodePrimitive("$$0")).toBe("$0");
    expect(decodePrimitive("$$x")).toBe("$x");
  });

  it("decodes undefined", () => {
    expect(decodePrimitive(SERIALIZED_UNDEFINED)).toBeUndefined();
  });

  it("decodes special numbers", () => {
    expect(decodePrimitive("$Infinity")).toBe(Infinity);
    expect(decodePrimitive("$-Infinity")).toBe(-Infinity);
    expect(Object.is(decodePrimitive("$-0"), -0)).toBe(true);
    expect(Number.isNaN(decodePrimitive("$NaN"))).toBe(true);
  });

  it("decodes bigint, symbols and dates", () => {
    expect(decodePrimitive("$n123")).toBe(123n);
    expect(decodePrimitive("$Sreact.suspense")).toBe(Symbol.for("react.suspense"));
    const date = decodePrimitive("$D2026-10-13T00:00:00.000Z") as Date;
    expect(date).toBeInstanceOf(Date);
    expect(date.toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });

  it("decodes server action references", () => {
    expect(decodePrimitive("$h1")).toEqual({ $$typeof: SERVER_REFERENCE, id: "1" });
  });

  it("reports references that only the reader can resolve", () => {
    for (const value of ["$0", "$1f", "$L1", "$@2", "$0:props:a"]) {
      expect(decodePrimitive(value)).toBe(NOT_A_PRIMITIVE);
    }
  });
});

describe("parseReference", () => {
  it("parses a by-value reference", () => {
    expect(parseReference("$1")).toEqual({ tag: "", id: 1, path: [] });
  });

  it("parses lazy, promise and server reference tags", () => {
    expect(parseReference("$L1f")).toEqual({ tag: "L", id: 31, path: [] });
    expect(parseReference("$@2")).toEqual({ tag: "@", id: 2, path: [] });
    expect(parseReference("$h3")).toEqual({ tag: "h", id: 3, path: [] });
  });

  it("splits a path into segments", () => {
    expect(parseReference("$1:props:a")).toEqual({ tag: "", id: 1, path: ["props", "a"] });
    expect(parseReference("$L1f:type")).toEqual({ tag: "L", id: 31, path: ["type"] });
  });
});
