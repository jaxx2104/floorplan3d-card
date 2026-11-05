// Icon glyphs for the GPU sprites: HA resolves icons (its icon rules by domain / device class / state, icon
// translations, the entity registry icon, mdi: and custom iconsets) inside <ha-state-icon> / <ha-icon>, which
// end in an <svg> path (ha-svg-icon). The resolver keeps one such element per icon in a hidden box of the card
// (never laid out per frame), reads the path data from it and tells the view when it changed. ha-icon loads
// its icon asynchronously: the read is retried on a back-off schedule after each change of the element's input,
// a sprite shows a placeholder until then.
import { paintStateIcon } from "../card/state-icon.ts";
import type { IconGlyph } from "../sprite-atlas.ts";
import type { Hass, HassEntity } from "../types/ha.ts";

const RECHECK_MS = [0, 40, 120, 400, 1200, 3000, 6000];
const PENDING_MS = 5000; // still nothing after the schedule: slow retries
const PENDING_TRIES = 12;

interface Host {
  el: HTMLElement;
  glyph: IconGlyph | null;
  sig: string;
  version: number;
  input: unknown[];
  step: number;
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
}

type Shadowed = Element & { shadowRoot: ShadowRoot | null };

/** The first <svg> under an element, through open shadow roots (ha-state-icon > ha-icon > ha-svg-icon > svg). */
export function findSvg(el: Element, depth = 0): SVGSVGElement | null {
  if (depth > 6) return null;
  if (el.localName === "svg") return el as SVGSVGElement;
  const roots: (Element | ShadowRoot)[] = [];
  const sr = (el as Shadowed).shadowRoot;
  if (sr) roots.push(sr);
  roots.push(el);
  for (const r of roots) {
    for (const c of Array.from(r.children)) {
      const s = findSvg(c, depth + 1);
      if (s) return s;
    }
  }
  return null;
}

/** Path data of an icon element (null: not resolved yet). The secondary path draws at half opacity. */
export function readGlyph(el: Element): IconGlyph | null {
  const svg = findSvg(el);
  if (!svg) return null;
  const paths = Array.from(svg.querySelectorAll("path"))
    .map((p) => ({
      d: p.getAttribute("d") || "",
      opacity: p.classList.contains("secondary-path") ? 0.5 : 1,
    }))
    .filter((p) => p.d);
  if (!paths.length) return null;
  const vb = (svg.getAttribute("viewBox") || "0 0 24 24")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBox: [number, number, number, number] =
    vb.length === 4 && vb.every(Number.isFinite)
      ? [vb[0], vb[1], vb[2], vb[3]]
      : [0, 0, 24, 24];
  return { paths, viewBox };
}

export class IconResolver {
  box: HTMLElement;
  hosts: Map<string, Host>;
  onChange: (() => void) | null;
  _disposed: boolean;

  constructor(container: HTMLElement) {
    const box = document.createElement("div");
    box.className = "fp-icon-box";
    box.setAttribute("aria-hidden", "true");
    Object.assign(box.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "24px",
      height: "24px",
      overflow: "hidden",
      visibility: "hidden",
      pointerEvents: "none",
      contain: "strict",
    });
    container.append(box);
    this.box = box;
    this.hosts = new Map();
    this.onChange = null;
    this._disposed = false;
  }

  _host(ref: string): Host {
    let h = this.hosts.get(ref);
    if (!h) {
      const el = document.createElement("span");
      this.box.append(el);
      h = {
        el,
        glyph: null,
        sig: "",
        version: 0,
        input: [],
        step: 0,
        tries: 0,
        timer: null,
      };
      this.hosts.set(ref, h);
    }
    return h;
  }

  /** The state icon of an entity as HA draws it (override: the card's icon, e.g. the live mower). -> its ref */
  stateIcon(
    key: string,
    hass: Hass,
    entityId: string,
    override?: string | null,
  ): string {
    const ref = "state:" + key;
    const h = this._host(ref);
    const st: HassEntity | undefined = hass.states[entityId];
    const input = [st, override || "", hass.entities, entityId];
    paintStateIcon(h.el, hass, entityId, override);
    if (input.some((x, i) => x !== h.input[i])) {
      h.input = input;
      this._watch(h);
    }
    return ref;
  }

  /** An icon by name (mdi:..., custom iconsets) through <ha-icon>. -> its ref */
  named(name: string): string {
    const ref = "name:" + name;
    const h = this._host(ref);
    if (h.input[0] !== name) {
      h.input = [name];
      let ic = h.el.firstElementChild;
      if (!ic || ic.localName !== "ha-icon") {
        ic = document.createElement("ha-icon");
        h.el.replaceChildren(ic);
      }
      ic.setAttribute("icon", name);
      this._watch(h);
    }
    return ref;
  }

  glyph(ref: string): IconGlyph | null {
    if (ref.startsWith("name:") && !this.hosts.has(ref))
      this.named(ref.slice(5));
    const h = this.hosts.get(ref);
    return h ? h.glyph : null;
  }

  version(ref: string): number {
    const h = this.hosts.get(ref);
    return h ? h.version : 0;
  }

  /** Drops the hosts whose ref is not in keep (markers gone). */
  keep(keep: Set<string>, prefix = "state:"): void {
    for (const [ref, h] of this.hosts) {
      if (!ref.startsWith(prefix) || keep.has(ref)) continue;
      if (h.timer) clearTimeout(h.timer);
      h.el.remove();
      this.hosts.delete(ref);
    }
  }

  // read now and again on the back-off schedule (the element renders and loads its icon asynchronously)
  _watch(h: Host): void {
    h.step = 0;
    h.tries = 0;
    if (h.timer) clearTimeout(h.timer);
    h.timer = null;
    this._check(h);
  }

  _check(h: Host): void {
    if (this._disposed) return;
    h.timer = null;
    const g = readGlyph(h.el);
    const sig = g
      ? g.viewBox.join() + "|" + g.paths.map((p) => p.opacity + p.d).join("|")
      : "";
    if (sig !== h.sig) {
      h.sig = sig;
      h.glyph = g;
      h.version++;
      if (this.onChange) this.onChange();
    }
    let wait: number | null = null;
    if (h.step < RECHECK_MS.length) wait = RECHECK_MS[h.step++];
    else if (!g && h.tries++ < PENDING_TRIES) wait = PENDING_MS;
    if (wait !== null) h.timer = setTimeout(() => this._check(h), wait);
  }

  dispose(): void {
    this._disposed = true;
    for (const h of this.hosts.values()) if (h.timer) clearTimeout(h.timer);
    this.hosts.clear();
    this.box.remove();
  }
}
