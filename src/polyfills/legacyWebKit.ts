/**
 * Legacy macOS WKWebView (Safari 13.1 – 15.6 on macOS 10.15 – 12.x) compatibility shims.
 * Bundled libraries such as Mermaid and Marked call ES2022/ES2023 built-ins
 * (`Object.hasOwn`, `.at()`, `structuredClone`, etc.) that are absent in older system WebKit.
 */

const defineMethod = (target: object, key: string, value: unknown): void => {
  try {
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch {
    // Ignore frozen/locked prototypes if any
  }
};

if (typeof (Object as unknown as Record<string, unknown>).hasOwn !== "function") {
  const hasOwnProp = Object.prototype.hasOwnProperty;
  defineMethod(Object, "hasOwn", (obj: unknown, prop: PropertyKey): boolean => {
    if (obj === null || obj === undefined) {
      throw new TypeError("Cannot convert undefined or null to object");
    }
    return hasOwnProp.call(Object(obj), prop);
  });
}

if (typeof (Array.prototype as unknown as Record<string, unknown>).at !== "function") {
  defineMethod(Array.prototype, "at", function (this: unknown[], index: number): unknown {
    const len = this.length >>> 0;
    const rel = Math.trunc(Number(index)) || 0;
    const k = rel >= 0 ? rel : len + rel;
    if (k < 0 || k >= len) return undefined;
    return this[k];
  });
}

if (typeof (String.prototype as unknown as Record<string, unknown>).at !== "function") {
  defineMethod(String.prototype, "at", function (this: string, index: number): string | undefined {
    const str = String(this);
    const rel = Math.trunc(Number(index)) || 0;
    const k = rel >= 0 ? rel : str.length + rel;
    if (k < 0 || k >= str.length) return undefined;
    return str.charAt(k);
  });
}

if (typeof (Array.prototype as unknown as Record<string, unknown>).findLast !== "function") {
  defineMethod(
    Array.prototype,
    "findLast",
    function <T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => boolean,
      thisArg?: unknown
    ): T | undefined {
      for (let i = (this.length >>> 0) - 1; i >= 0; i--) {
        if (predicate.call(thisArg, this[i], i, this)) {
          return this[i];
        }
      }
      return undefined;
    }
  );
}

if (typeof (Array.prototype as unknown as Record<string, unknown>).findLastIndex !== "function") {
  defineMethod(
    Array.prototype,
    "findLastIndex",
    function <T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => boolean,
      thisArg?: unknown
    ): number {
      for (let i = (this.length >>> 0) - 1; i >= 0; i--) {
        if (predicate.call(thisArg, this[i], i, this)) {
          return i;
        }
      }
      return -1;
    }
  );
}

if (typeof String.prototype.replaceAll !== "function") {
  defineMethod(
    String.prototype,
    "replaceAll",
    function (
      this: string,
      search: string | RegExp,
      replacement: string | ((substring: string, ...args: unknown[]) => string)
    ): string {
      const str = String(this);
      if (search instanceof RegExp) {
        if (!search.global) {
          throw new TypeError("replaceAll must be called with a global RegExp");
        }
        return str.replace(search, replacement as string);
      }
      const needle = String(search);
      if (needle === "") {
        return str;
      }
      return str.split(needle).join(String(replacement));
    }
  );
}

if (typeof (globalThis as unknown as Record<string, unknown>).structuredClone !== "function") {
  const cloneValue = (value: unknown, seen = new WeakMap<object, unknown>()): unknown => {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    if (value instanceof RegExp) {
      return new RegExp(value.source, value.flags);
    }
    if (value instanceof ArrayBuffer) {
      return value.slice(0);
    }
    if (ArrayBuffer.isView(value)) {
      const clonedBuf = new ArrayBuffer(value.byteLength);
      new Uint8Array(clonedBuf).set(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      );
      if ("BYTES_PER_ELEMENT" in value) {
        const Ctor = (
          value as unknown as {
            constructor: new (buf: ArrayBuffer) => unknown;
          }
        ).constructor;
        return new Ctor(clonedBuf);
      }
      return new DataView(clonedBuf);
    }
    if (Array.isArray(value)) {
      const copy: unknown[] = [];
      seen.set(value, copy);
      for (let i = 0; i < value.length; i++) {
        if (i in value) {
          copy[i] = cloneValue(value[i], seen);
        }
      }
      return copy;
    }
    if (value instanceof Map) {
      const copy = new Map<unknown, unknown>();
      seen.set(value, copy);
      value.forEach((v, k) => {
        copy.set(cloneValue(k, seen), cloneValue(v, seen));
      });
      return copy;
    }
    if (value instanceof Set) {
      const copy = new Set<unknown>();
      seen.set(value, copy);
      value.forEach((v) => {
        copy.add(cloneValue(v, seen));
      });
      return copy;
    }
    const copy: Record<string, unknown> = {};
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      copy[key] = cloneValue((value as Record<string, unknown>)[key], seen);
    }
    return copy;
  };

  defineMethod(globalThis, "structuredClone", (value: unknown) => cloneValue(value));
}

export {};
