// Facade helpers: the card keeps every member its callers use (edit mode, the debug overlay, headless
// checks, the parts themselves) under the old name, forwarding to the part that owns it.

// methods: proto[name](...args) -> this[partKey][name](...args)
// fields: get / set accessors on proto -> this[partKey][name] (the same object, identity kept)
export function defineDelegates(proto, partKey, { methods = [], fields = [] } = {}) {
  for (const name of methods) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) throw new Error(`delegate ${name} already defined`);
    Object.defineProperty(proto, name, {
      value(...args) { return this[partKey][name](...args); },
      writable: true, configurable: true,
    });
  }
  for (const name of fields) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) throw new Error(`delegate ${name} already defined`);
    Object.defineProperty(proto, name, {
      get() { return this[partKey][name]; },
      set(v) { this[partKey][name] = v; },
      configurable: true,
    });
  }
}
