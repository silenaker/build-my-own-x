/**
 * `createRoot` needs only a small slice of the DOM. This shim provides exactly
 * that slice so tests can mount and inspect trees without a browser.
 */
import { createRoot } from "../react-dom.ts";
import { type Any } from "../shared.ts";

export class TestNode {
  nodeType: number;
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }
  appendChild<T extends TestNode>(child: T): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild<T extends TestNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  get firstChild(): TestNode | null {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }
}

export class TestText extends TestNode {
  data: string;
  constructor(data: string) {
    super(3);
    this.data = data;
  }
  get nodeValue(): string {
    return this.data;
  }
  get textContent(): string {
    return this.data;
  }
}

export class TestElement extends TestNode {
  tagName: string;
  ownerDocument: TestDocument;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: Any) => void>>();
  rawHTML: string | null = null;

  constructor(document: TestDocument, tagName: string) {
    super(1);
    this.ownerDocument = document;
    this.tagName = tagName;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }
  addEventListener(type: string, listener: (event: Any) => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) this.listeners.set(type, [listener]);
    else list.push(listener);
  }
  /** Test helper: deliver an event to the listeners of `type`. */
  dispatch(type: string, event: Any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  get innerHTML(): string {
    return this.rawHTML !== null ? this.rawHTML : this.childNodes.map(textOf).join("");
  }
  set innerHTML(html: string) {
    this.rawHTML = html;
    this.childNodes = [];
  }
  get textContent(): string {
    return this.childNodes.map(textOf).join("");
  }
}

export class TestDocument {
  createElement(tagName: string): TestElement {
    return new TestElement(this, tagName);
  }
  createTextNode(text: string): TestText {
    return new TestText(text);
  }
}

function textOf(node: TestNode): string {
  if (node instanceof TestText) return node.data;
  if (node instanceof TestElement) return node.textContent;
  return "";
}

/** `createRoot(...).render(element)` into a fresh container, then return it. */
export function mount(element: Any): TestElement {
  const document = new TestDocument();
  const container = document.createElement("root");
  createRoot(container as unknown as Element).render(element);
  return container;
}

/** Narrow a `childNodes` entry to an element (tests know what they put there). */
export const asElement = (node: TestNode | undefined): TestElement => node as TestElement;
