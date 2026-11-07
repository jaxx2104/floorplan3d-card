"""Floorplan 3D: serves floorplan3d-card so no manual Lovelace resource is needed.

Added from Settings → Devices & services (or `floorplan3d:` in configuration.yaml, which is
imported as a config entry). The layout is part of the card YAML (`layout:`) and the model a
file under config/www (`model: /local/house.glb`), so nothing is stored here.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import CARD_FILENAME, CARD_URL_BASE, DOMAIN

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """YAML `floorplan3d:` is imported as a config entry."""
    if DOMAIN in config and not hass.config_entries.async_entries(DOMAIN):
        hass.async_create_task(
            hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_IMPORT}, data={})
        )
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Register the card resource (once per HA run)."""
    if DOMAIN in hass.data:
        return True  # reloaded entry: the static path stays registered
    hass.data[DOMAIN] = True
    await _async_register_card(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Nothing to tear down; the card stays until restart."""
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the bundled card and load its entry on every dashboard.

    The entry is a few kB; it imports the card from frontend/chunks/ when a card is shown, so the
    whole directory is served. Chunk names carry a content hash and the entry URL the file's
    mtime, so everything can be cached (cache headers on).
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
