// Facade helpers: the card keeps every member its callers use (edit mode, the debug overlay, headless
// checks, the parts themselves) under the old name, forwarding to the part that owns it.

export interface DelegateNames<P> {
  methods?: readonly (keyof P & string)[];
  fields?: readonly (keyof P & string)[];
}

// The host as the accessors see it: the part under partKey, any member by name.
type Host = Record<string, Record<string, unknown>>;

// methods: proto[name](...args) -> this[partKey][name](...args)
// fields: get / set accessors on proto -> this[partKey][name] (the same object, identity kept)
// The host's TypeScript view of the members comes from an interface merged with its class (see the card).
export function defineDelegates<P = Record<string, unknown>>(
  proto: object,
  partKey: string,
  { methods = [], fields = [] }: DelegateNames<P> = {},
): void {
  for (const name of methods) {
    if (Object.prototype.hasOwnProperty.call(proto, name))
      throw new Error(`delegate ${name} already defined`);
    Object.defineProperty(proto, name, {
      value(this: Host, ...args: unknown[]) {
        const part = this[partKey];
        return (part[name] as (...a: unknown[]) => unknown).apply(part, args); // called on the part (its this)
      },
      writable: true,
      configurable: true,
    });
  }
  for (const name of fields) {
    if (Object.prototype.hasOwnProperty.call(proto, name))
      throw new Error(`delegate ${name} already defined`);
    Object.defineProperty(proto, name, {
      get(this: Host) {
        return this[partKey][name];
      },
      set(this: Host, v: unknown) {
        this[partKey][name] = v;
      },
      configurable: true,
    });
  }
}
