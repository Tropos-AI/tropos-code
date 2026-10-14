// web/src/test-setup.ts — a DOM for the web app's tests (happy-dom), scoped to the test files that ask for it.
// `bun test` runs every file in one process, so a global preload would also give the Ink/CLI tests a `window`.
// DOM test files call `withDom()` first, then import react-dom / testing-library with top-level await (static imports
// are evaluated before withDom() runs, and testing-library registers its own hooks at import time):
//
//   import { withDom } from "@/test-setup";
//   withDom();
//   const { render, screen, act } = await import("@testing-library/react");
//   const { MyComponent } = await import("@/components/…");
//
// To run the web tests with a global DOM instead: `bun test --preload ./web/src/test-setup-global.ts web/src`.
import { afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

export const TEST_ORIGIN = "http://127.0.0.1:4317/";

/**
 * happy-dom's Node.prototype.nodeName getter returns "" instead of dispatching to the subclass (Element, Text …) as
 * browsers do. DOMPurify reads nodeName through that getter, so without this shim it sees every element as unnamed and
 * sanitizes wrongly. Test-only: the browser needs nothing of the kind.
 */
function makeNodeNamePolymorphic(): void {
  const NodeCtor = (globalThis as unknown as { Node: { prototype: object } }).Node;
  const base = NodeCtor.prototype;
  const own = Object.getOwnPropertyDescriptor(base, "nodeName");
  if (!own?.get || (own.get as { polymorphic?: boolean }).polymorphic) return;
  const get = function nodeName(this: object): string {
    for (let proto = Object.getPrototypeOf(this) as object | null; proto && proto !== base; proto = Object.getPrototypeOf(proto) as object | null) {
      const desc = Object.getOwnPropertyDescriptor(proto, "nodeName");
      if (desc?.get) return desc.get.call(this) as string;
    }
    return own.get!.call(this) as string;
  };
  (get as { polymorphic?: boolean }).polymorphic = true;
  Object.defineProperty(base, "nodeName", { ...own, get });
}

/** whatToShow bit for each nodeType (DOM spec: 1 << (nodeType - 1)). */
const showBit = (node: Node): number => 1 << (node.nodeType - 1);

/** The next node in document order after `node`, without leaving `root`. */
function following(node: Node, root: Node, skipChildren = false): Node | null {
  if (!skipChildren && node.firstChild) return node.firstChild;
  for (let at: Node | null = node; at && at !== root; at = at.parentNode) {
    if (at.nextSibling) return at.nextSibling;
  }
  return null;
}

/**
 * happy-dom's NodeIterator loses its place when the node it last returned is removed, so everything after the first
 * removed element goes unvisited. DOMPurify removes nodes while iterating, which browsers handle per the DOM spec.
 * This forward-only iterator re-finds its place from where the removed node used to be. Test-only.
 */
function makeNodeIteratorRemovalSafe(): void {
  let proto: object | null = Object.getPrototypeOf(document) as object | null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "createNodeIterator")) proto = Object.getPrototypeOf(proto) as object | null;
  if (!proto || (proto as { __removalSafe?: boolean }).__removalSafe) return;
  Object.defineProperty(proto, "__removalSafe", { value: true });
  Object.defineProperty(proto, "createNodeIterator", {
    configurable: true,
    writable: true,
    value(root: Node, whatToShow = 0xffffffff) {
      let ref: Node | null = null;
      let refParent: Node | null = null;
      let refPrev: Node | null = null;
      let done = false;
      const step = (): Node | null => {
        if (!ref) return root;
        if (ref === root || root.contains(ref)) return following(ref, root);
        // `ref` was removed: continue from where it was (DOMPurify inserts kept content after it before removing it).
        if (refPrev && refPrev.parentNode === refParent) return following(refPrev, root, true);
        if (refParent && (refParent === root || root.contains(refParent))) return refParent.firstChild ?? following(refParent, root, true);
        return null;
      };
      return {
        root,
        whatToShow,
        nextNode(): Node | null {
          while (!done) {
            const next = step();
            if (!next) {
              done = true;
              return null;
            }
            ref = next;
            refParent = next.parentNode;
            refPrev = next.previousSibling;
            if (whatToShow & showBit(next)) return next;
          }
          return null;
        },
        detach() {},
      };
    },
  });
}

/**
 * testing-library's `screen` binds its queries to `document.body` when the module first loads. `bun test` shares one
 * module registry across files, so after an earlier DOM test file unregistered its window, `screen` would still point
 * at that dead document. Re-bind it to the new body (@testing-library/dom registers no hooks, so loading it is safe).
 */
function rebindScreen(): void {
  const dom = require("@testing-library/dom") as typeof import("@testing-library/dom");
  Object.assign(dom.screen, dom.getQueriesForElement(document.body));
}

/**
 * The runtime's own timers, captured before any window is registered. happy-dom replaces the globals with the window's
 * timers, and React's scheduler keeps whichever it saw first; once that window is closed (the next DOM test file
 * registers a fresh one) its timers never fire and updates outside act() would never render. Keep the runtime's.
 */
const RUNTIME_TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, queueMicrotask };

function keepRuntimeTimers(): void {
  for (const [name, fn] of Object.entries(RUNTIME_TIMERS)) {
    Object.defineProperty(globalThis, name, { value: fn, configurable: true, writable: true });
  }
}

export function installDom(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: TEST_ORIGIN });
  keepRuntimeTimers();
  makeNodeNamePolymorphic();
  makeNodeIteratorRemovalSafe();
  rebindScreen();
}

/** Macrotask turns given to React's scheduler before the window goes away. */
const DRAIN_TURNS = 5;

/**
 * Lets work React already scheduled run while the window still exists. The scheduler uses the runtime's timers
 * (keepRuntimeTimers), so an update queued at the very end of a file (a late RPC answer, a final animation frame)
 * would otherwise render after unregister() and throw "undefined is not an object (evaluating 'window.event')",
 * an unhandled error that fails the run on a loaded CI machine.
 */
async function drainScheduler(): Promise<void> {
  for (let i = 0; i < DRAIN_TURNS; i++) await new Promise<void>((resolve) => RUNTIME_TIMERS.setTimeout(resolve, 10));
}

export async function uninstallDom(): Promise<void> {
  if (!GlobalRegistrator.isRegistered) return;
  await drainScheduler();
  await GlobalRegistrator.unregister();
}

/** Installs happy-dom now and removes it after the calling test file's tests. */
export function withDom(): void {
  installDom();
  afterAll(uninstallDom);
}
