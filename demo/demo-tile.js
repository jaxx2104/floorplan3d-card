// A minimal stand-in for HA's card helpers (window.loadCardHelpers) and its tile card, so the
// object popup shows usable rows on the demo page: the icon toggles and the name opens more-info
// (hass-action, as HA's tile fires them), the features call services the way HA's do.
// Supported features: light-brightness, light-color-temp, cover-open-close, cover-position,
// lawn-mower-commands, vacuum-commands; any other feature shows its type only.
// Headless checks: .fp-demo-tile[data-entity], .icon, .name, .state, [data-feature=<type>] inputs / buttons.

const STYLE = `.fp-demo-tile { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; border-radius: 10px;
  border: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
.fp-demo-tile .top { display: flex; align-items: center; gap: 8px; }
.fp-demo-tile button { font: inherit; cursor: pointer; color: var(--primary-text-color); }
.fp-demo-tile .icon { width: 32px; height: 32px; border-radius: 50%; border: none; padding: 0;
  background: rgba(127,127,127,.2); display: flex; align-items: center; justify-content: center; flex: none; }
.fp-demo-tile.on .icon { background: var(--state-light-active-color, #ff9800); color: #fff; }
.fp-demo-tile .icon ha-icon { --mdc-icon-size: 18px; }
.fp-demo-tile .text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.fp-demo-tile .name { border: none; background: none; padding: 0; text-align: left; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fp-demo-tile .state { font-size: 12px; color: var(--secondary-text-color); }
.fp-demo-tile input[type=range] { width: 100%; margin: 0; accent-color: var(--primary-color); }
.fp-demo-tile .cmds { display: flex; gap: 6px; }
.fp-demo-tile .cmds button { flex: 1; font-size: 12px; padding: 4px 8px; border-radius: 10px;
  border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: none; }
.fp-demo-tile .other { font-size: 11px; color: var(--secondary-text-color); }`;

const ICONS = {
  light: "mdi:lightbulb",
  switch: "mdi:toggle-switch-variant",
  lawn_mower: "mdi:robot-mower",
  vacuum: "mdi:robot-vacuum",
  cover: "mdi:window-shutter",
  climate: "mdi:thermostat",
  sensor: "mdi:eye",
};
const CMD_LABELS = {
  start_pause: "Start / pause",
  dock: "Dock",
  return_home: "Return home",
};
const domainOf = (e) => String(e).split(".")[0];
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

class DemoTile extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  get hass() {
    return this._hass;
  }

  _fire(action) {
    this.dispatchEvent(
      new CustomEvent("hass-action", {
        detail: {
          config: { entity: this._config.entity, tap_action: action },
          action: "tap",
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _call(domain, service, data = {}) {
    if (!this._hass) return;
    this._hass.callService(domain, service, {
      entity_id: this._config.entity,
      ...data,
    });
  }

  _render() {
    const c = this._config,
      d = domainOf(c.entity);
    const feats = (c.features || [])
      .map((f) => {
        switch (f.type) {
          case "light-brightness":
            return `<input type="range" data-feature="light-brightness" min="1" max="100" step="1" aria-label="Brightness">`;
          case "light-color-temp":
            return `<input type="range" data-feature="light-color-temp" step="50" aria-label="Colour temperature">`;
          case "cover-position":
            return `<input type="range" data-feature="cover-position" min="0" max="100" step="1" aria-label="Position">`;
          case "cover-open-close":
            return `<span class="cmds"><button data-feature="cover-open-close" data-cmd="open">Open</button><button data-feature="cover-open-close" data-cmd="close">Close</button></span>`;
          case "lawn-mower-commands":
          case "vacuum-commands":
            return `<span class="cmds">${(f.commands || [])
              .map(
                (x) =>
                  `<button data-feature="${f.type}" data-cmd="${esc(x)}">${esc(CMD_LABELS[x] || x)}</button>`,
              )
              .join("")}</span>`;
          default:
            return `<span class="other" data-feature="${esc(f.type)}">${esc(f.type)}</span>`;
        }
      })
      .join("");
    this.innerHTML = `<style>${STYLE}</style><div class="fp-demo-tile" data-entity="${esc(c.entity)}"><div class="top">
      <button class="icon" title="Toggle"><ha-icon icon="${ICONS[d] || "mdi:circle-outline"}"></ha-icon></button>
      <span class="text"><button class="name" title="More info"></button><span class="state"></span></span></div>${feats}</div>`;
    const q = (s) => this.querySelector(s);
    q(".icon").addEventListener("click", () =>
      this._fire({ action: "toggle" }),
    );
    q(".name").addEventListener("click", () =>
      this._fire({ action: "more-info" }),
    );
    for (const el of this.querySelectorAll("[data-feature]")) {
      const type = el.dataset.feature;
      if (el.tagName === "INPUT")
        el.addEventListener("change", () => {
          const v = Number(el.value);
          if (type === "light-brightness")
            this._call("light", "turn_on", { brightness_pct: v });
          else if (type === "light-color-temp")
            this._call("light", "turn_on", { color_temp_kelvin: v });
          else if (type === "cover-position")
            this._call("cover", "set_cover_position", { position: v });
        });
      else if (el.tagName === "BUTTON")
        el.addEventListener("click", () => this._command(type, el.dataset.cmd));
    }
    this._update();
  }

  _command(type, cmd) {
    const s = this._state();
    const busy = s && /^(mowing|cleaning)$/.test(s.state);
    if (type === "cover-open-close")
      this._call("cover", cmd === "open" ? "open_cover" : "close_cover");
    else if (type === "lawn-mower-commands")
      this._call(
        "lawn_mower",
        cmd === "dock" ? "dock" : busy ? "pause" : "start_mowing",
      );
    else if (type === "vacuum-commands")
      this._call(
        "vacuum",
        cmd === "return_home" ? "return_to_base" : busy ? "pause" : "start",
      );
  }

  _state() {
    const c = this._config;
    return c && this._hass && this._hass.states
      ? this._hass.states[c.entity]
      : null;
  }

  _update() {
    const c = this._config;
    if (!c || !this.firstElementChild) return;
    const s = this._state();
    const a = (s && s.attributes) || {};
    const q = (sel) => this.querySelector(sel);
    q(".fp-demo-tile").classList.toggle("on", !!s && s.state === "on");
    q(".name").textContent = c.name || a.friendly_name || c.entity;
    const pct =
      s && s.state === "on" && typeof a.brightness === "number"
        ? ` · ${Math.round((a.brightness / 255) * 100)} %`
        : "";
    q(".state").textContent = s
      ? `${s.state}${a.unit_of_measurement ? " " + a.unit_of_measurement : ""}${pct}`
      : "unavailable";
    const active = this.getRootNode().activeElement;
    const b = q("[data-feature=light-brightness]");
    if (b && b !== active)
      b.value = String(
        typeof a.brightness === "number"
          ? Math.max(1, Math.round((a.brightness / 255) * 100))
          : 1,
      );
    const k = q("[data-feature=light-color-temp]");
    if (k && k !== active) {
      k.min = String(a.min_color_temp_kelvin || 2000);
      k.max = String(a.max_color_temp_kelvin || 6500);
      if (typeof a.color_temp_kelvin === "number")
        k.value = String(a.color_temp_kelvin);
    }
    const p = q("[data-feature=cover-position]");
    if (p && p !== active && typeof a.current_position === "number")
      p.value = String(a.current_position);
  }
}

if (!customElements.get("fp-demo-tile"))
  customElements.define("fp-demo-tile", DemoTile);

if (typeof window.loadCardHelpers !== "function")
  window.loadCardHelpers = async () => ({
    createCardElement(config) {
      const el = document.createElement("fp-demo-tile");
      el.setConfig(config);
      return el;
    },
  });
