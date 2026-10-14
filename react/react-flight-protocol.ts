import { REACT_ELEMENT_TYPE, serverReferenceValue } from "./react.ts";
import { type Any } from "./shared.ts";

// ---- Rows ------------------------------------------------------------------

/** Row kind: a model row (default), an import-metadata row, or an error row. */
export type RowTag = "" | "I" | "E";

export interface WireRow {
  /** Row id — an allocation counter in hex, not a position. */
  id: number;
  /** Row kind; drives how `payload` is interpreted. */
  tag: RowTag;
  /** Parsed JSON payload — or, for a `T` text row, the raw text. */
  payload: Any;
}

/** Parse one wire row. */
export function parseRow(row: string): WireRow {
  const colon = row.indexOf(":");
  const id = parseInt(row.slice(0, colon), 16);
  const rest = row.slice(colon + 1);
  switch (rest[0]) {
    case "T": {
      // `<id>:T<byteLenHex>,<text>` — length-prefixed, not JSON, no trailing \n.
      const comma = rest.indexOf(",");
      return { id, tag: "", payload: rest.slice(comma + 1) };
    }
    case "I":
      return { id, tag: "I", payload: JSON.parse(rest.slice(1)) };
    case "E":
      return { id, tag: "E", payload: JSON.parse(rest.slice(1)) };
    default:
      return { id, tag: "", payload: JSON.parse(rest) };
  }
}

/** Encode one wire row — the inverse of `parseRow`. */
export function encodeRow(id: number, tag: RowTag, payload: string): string {
  return id.toString(16) + ":" + tag + payload + "\n";
}

/** Split a buffer into complete rows, returning the trailing (partial) row. */
export function splitRows(buffer: string): { rows: string[]; rest: string } {
  const rows = buffer.split("\n");
  const rest = rows.pop() as string;
  return { rows, rest };
}

// ---- Value strings: the encoder side ---------------------------------------
// Each pairs with a case of `decodePrimitive` below (or with `parseReference`).

/** `$<id>` — a by-value reference. */
export const serializeByValueID = (id: number): string => "$" + id.toString(16);
/** `$L<id>` — a lazy reference. */
export const serializeLazyID = (id: number): string => "$L" + id.toString(16);
/** `$@<id>` — a promise reference. */
export const serializePromiseID = (id: number): string => "$@" + id.toString(16);
/** `$h<id>` — a server action reference. */
export const serializeServerReferenceID = (id: number): string => "$h" + id.toString(16);

/** `$undefined` — JSON has no `undefined`. */
export const SERIALIZED_UNDEFINED = "$undefined";

/** Escape a real string that starts with `$`. */
export function serializeString(value: string): string {
  return value[0] === "$" ? "$" + value : value;
}

/** Serialize a number, spelling the ones JSON cannot express. */
export function serializeNumber(value: number): number | string {
  if (Number.isFinite(value)) return Object.is(value, -0) ? "$-0" : value;
  if (value === Infinity) return "$Infinity";
  if (value === -Infinity) return "$-Infinity";
  return "$NaN";
}

/** Serialize a `Symbol.for(...)` symbol (the server rejects non-registered ones). */
export function serializeSymbol(value: symbol): string {
  return "$S" + value.description;
}

/** Serialize a `Date` as its ISO string. */
export function serializeDate(value: Date): string {
  return "$D" + value.toISOString();
}

/** Serialize a `BigInt` as its decimal digits. */
export function serializeBigInt(value: bigint): string {
  return "$n" + value.toString(10);
}

// ---- Value strings: the decoder side ---------------------------------------

/**
 * Sentinel returned by `decodePrimitive` for a `$`-string that is a *reference*
 * rather than a self-contained value: `$L<id>`, `$@<id>`, `$<id>`, `$<id>:<path>`.
 */
export const NOT_A_PRIMITIVE: unique symbol = Symbol("react-flight.notAPrimitive");

/** Decode a `$`-prefixed string whose value is carried inline. */
export function decodePrimitive(str: string): Any | typeof NOT_A_PRIMITIVE {
  if (str === "$") return REACT_ELEMENT_TYPE; // the element-type marker
  if (str[0] !== "$") return str; // an ordinary string
  switch (str[1]) {
    case "$":
      return str.slice(1); // escaped: "$$foo" -> "$foo"
    case "S":
      return Symbol.for(str.slice(2));
    case "h":
      return serverReferenceValue(str.slice(2));
    case "u":
      return undefined; // $undefined
    case "I":
      return Infinity; // $Infinity
    case "N":
      return NaN; // $NaN
    case "-":
      return str === "$-0" ? -0 : -Infinity;
    case "D":
      return new Date(Date.parse(str.slice(2))); // $D<iso>
    case "n":
      return BigInt(str.slice(2)); // $n<digits>
    default:
      return NOT_A_PRIMITIVE; // $L / $@ / $<id> / $<id>:<path>
  }
}

export type ReferenceTag = "" | "L" | "@" | "h";

export interface ParsedReference {
  tag: ReferenceTag;
  id: number;
  path: string[];
}

const REFERENCE_TAGS = "L@h";

/** Split `$[tag]<idHex>[:<path...>]` into a tag, an id and path segments. */
export function parseReference(str: string): ParsedReference {
  let rest = str.slice(1); // drop the leading "$"
  let tag: ReferenceTag = "";
  if (rest[0] !== undefined && REFERENCE_TAGS.includes(rest[0])) {
    tag = rest[0] as ReferenceTag;
    rest = rest.slice(1);
  }
  const colon = rest.indexOf(":");
  const idPart = colon === -1 ? rest : rest.slice(0, colon);
  const path = colon === -1 ? [] : rest.slice(colon + 1).split(":");
  return { tag, id: parseInt(idPart, 16), path };
}
