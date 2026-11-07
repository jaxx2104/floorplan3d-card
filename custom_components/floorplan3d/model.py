"""Serve the house model (.glb) to logged-in users.

Files live in <config>/floorplan3d/models/<key>.glb, outside /config/www (which anyone can read
without logging in), and are copied there by hand (scp). The card reads them with
`model: /api/floorplan3d/model/<key>`. Read only: nothing is uploaded through Home Assistant.
"""

from __future__ import annotations

import re
from http import HTTPStatus
from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import MODEL_DIR, MODEL_URL

KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def model_path(hass: HomeAssistant, key: str) -> Path:
    return Path(hass.config.path(MODEL_DIR)) / f"{key}.glb"


class ModelView(HomeAssistantView):
    """GET / HEAD for any logged-in user (ETag and Last-Modified from the file, for the card's cache)."""

    url = MODEL_URL + "/{key}"
    name = "api:floorplan3d:model"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(self, request: web.Request, key: str) -> web.StreamResponse:
        if not KEY_RE.match(key):
            return self.json_message("Invalid key", HTTPStatus.BAD_REQUEST)
        path = model_path(self.hass, key)
        if not await self.hass.async_add_executor_job(path.is_file):
            return self.json_message("No model", HTTPStatus.NOT_FOUND)
        return web.FileResponse(
            path,
            headers={"Content-Type": "model/gltf-binary", "Cache-Control": "private, no-cache"},
        )

    head = get
