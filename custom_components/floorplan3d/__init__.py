"""Floorplan 3D: shared layout storage for floorplan3d-card.

Added from Settings → Devices & services (or `floorplan3d:` in configuration.yaml, which is
imported as a config entry). Stores card layouts in .storage/floorplan3d.layouts, exposes them
over the websocket API, and serves the bundled card JavaScript so no manual Lovelace resource
is needed.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_FILENAME,
    CARD_URL_BASE,
    DOMAIN,
    MAX_LAYOUT_BYTES,
    SAVE_DELAY,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .model import ModelView

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

KEY_SCHEMA = vol.All(str, vol.Length(min=1, max=64))


class LayoutStore:
    """Layouts by key, persisted with the HA storage helper."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._layouts: dict[str, Any] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load()
        self._layouts = (data or {}).get("layouts", {})

    def get(self, key: str) -> dict[str, Any] | None:
        return self._layouts.get(key)

    def set(self, key: str, layout: dict[str, Any]) -> None:
        self._layouts[key] = layout
        self._store.async_delay_save(lambda: {"layouts": self._layouts}, SAVE_DELAY)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """YAML `floorplan3d:` is imported as a config entry."""
    if DOMAIN in config and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_IMPORT}, data={})
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up storage, websocket commands and the card resource (once per HA run)."""
    if DOMAIN in hass.data:
        return True  # reloaded entry: commands and static path stay registered
    store = LayoutStore(hass)
    await store.async_load()
    hass.data[DOMAIN] = store

    websocket_api.async_register_command(hass, ws_get_layout)
    websocket_api.async_register_command(hass, ws_set_layout)
    hass.http.register_view(ModelView(hass))

    await _async_register_card(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Nothing to tear down; websocket commands and the card stay until restart."""
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled card and load its entry on every dashboard.

    The entry is a few kB; it imports the card and edit mode from frontend/chunks/ when a card is
    shown, so the whole directory is served. Chunk names carry a content hash and the entry URL the
    file's mtime, so everything can be cached (cache headers on).
    """
    frontend = Path(__file__).parent / "frontend"
    path = frontend / CARD_FILENAME
    if not await hass.async_add_executor_job(path.is_file):
        _LOGGER.warning(
            "%s is not bundled with this install; add it as a dashboard resource manually",
            CARD_FILENAME,
        )
        return
    version = (await hass.async_add_executor_job(path.stat)).st_mtime_ns
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL_BASE, str(frontend), True)]
    )
    add_extra_js_url(hass, f"{CARD_URL_BASE}/{CARD_FILENAME}?v={version}")


@websocket_api.websocket_command(
    {vol.Required("type"): "floorplan3d/layout/get", vol.Required("key"): KEY_SCHEMA}
)
@callback
def ws_get_layout(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the stored layout for a key (null when none is stored yet)."""
    connection.send_result(msg["id"], {"layout": hass.data[DOMAIN].get(msg["key"])})


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): "floorplan3d/layout/set",
        vol.Required("key"): KEY_SCHEMA,
        vol.Required("layout"): dict,
    }
)
@callback
def ws_set_layout(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Store a layout. Admin only: layouts are shared by every user."""
    layout = msg["layout"]
    if len(json.dumps(layout)) > MAX_LAYOUT_BYTES:
        connection.send_error(msg["id"], "too_large", "Layout is too large")
        return
    hass.data[DOMAIN].set(msg["key"], layout)
    connection.send_result(msg["id"])
