// A stand-in for HA's frontend action handling (handle-action.ts, the hass-action listener on the
// root element) and its toasts, so the demo behaves without HA: toggle, more-info, navigate, url,
// perform-action, assist (logged), confirmation. Headless checks read window.__hassActions,
// window.__notifications and may set window.__demoConfirm(text) -> boolean instead of the browser dialog.
// Simplified: toggle calls <domain>.toggle (homeassistant.toggle outside light / switch / fan /
// input_boolean) where HA calls turn_on / turn_off.

const TOGGLE_DOMAINS = new Set(["light", "switch", "fan", "input_boolean"]);

const log = (text) => {
  const el = document.querySelector("#log");
  if (el) el.textContent = text;
};

function notify(message) {
  (window.__notifications = window.__notifications || []).push(message);
  log("toast: " + message);
}

function navigate(path, replace) {
  if (replace) history.replaceState(history.state, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(
    new CustomEvent("location-changed", { detail: { replace } }),
  );
}

function run(hass, node, detail) {
  const config = (detail && detail.config) || {};
  const which = (detail && detail.action) || "tap";
  const a = config[`${which}_action`] || { action: "more-info" };
  const c = a.confirmation;
  if (
    c &&
    !(
      Array.isArray(c.exemptions) &&
      c.exemptions.some((x) => x && hass.user && x.user === hass.user.id)
    )
  ) {
    const text = (c && c.text) || "Are you sure?";
    const ok = window.__demoConfirm
      ? window.__demoConfirm(text)
      : window.confirm(text);
    if (!ok) return;
  }
  switch (a.action) {
    case "more-info": {
      const entityId = a.entity || config.entity;
      if (entityId)
        node.dispatchEvent(
          new CustomEvent("hass-more-info", {
            detail: { entityId },
            bubbles: true,
            composed: true,
          }),
        );
      else notify("No entity provided for more-info");
      break;
    }
    case "navigate":
      if (a.navigation_path)
        navigate(a.navigation_path, !!a.navigation_replace);
      else notify("No navigation path specified");
      break;
    case "url":
      if (a.url_path) window.open(a.url_path);
      else notify("No URL specified");
      break;
    case "toggle": {
      const e = config.entity;
      if (!e) {
        notify("No entity provided to toggle");
        break;
      }
      const d = e.split(".")[0];
      callService(hass, TOGGLE_DOMAINS.has(d) ? d : "homeassistant", "toggle", {
        entity_id: e,
      });
      break;
    }
    case "perform-action":
    case "call-service": {
      const s = a.perform_action || a.service;
      if (!s) {
        notify("No action specified");
        break;
      }
      const [domain, service] = s.split(".", 2);
      callService(
        hass,
        domain,
        service,
        { ...a.data, ...a.service_data },
        a.target,
      );
      break;
    }
    case "assist":
      log("assist: " + (a.pipeline_id || "default"));
      break;
    default:
  }
}

// hass.callService in HA's frontend shows a failure as a toast.
function callService(hass, ...args) {
  const fail = (err) => notify((err && err.message) || "Action failed");
  try {
    const p = hass.callService(...args);
    if (p && typeof p.catch === "function") p.catch(fail);
  } catch (err) {
    fail(err);
  }
}

/**
 * Handles hass-action / hass-notification on the page; hass(): the current mock hass. The card that
 * fired the action lends its own hass when it has one (checks swap it for a failing one).
 */
export function installMockActions(hass) {
  window.addEventListener("hass-action", (e) => {
    (window.__hassActions = window.__hassActions || []).push(e.detail);
    const src = e.composedPath()[0];
    run((src && src._hass) || hass(), e.target, e.detail);
  });
  window.addEventListener("hass-notification", (e) =>
    notify(e.detail && e.detail.message),
  );
}
