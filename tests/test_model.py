"""Tests for serving the house model (read only, logged-in users)."""

from pathlib import Path

import pytest

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from custom_components.floorplan3d.const import DOMAIN

URL = "/api/floorplan3d/model/default"


@pytest.fixture
async def setup(hass: HomeAssistant, tmp_path) -> Path:
    hass.config.config_dir = str(tmp_path)  # models must not leak between tests or runs
    assert await async_setup_component(hass, "http", {})
    assert await async_setup_component(hass, DOMAIN, {DOMAIN: {}})
    await hass.async_block_till_done()
    return tmp_path / "floorplan3d" / "models"


async def test_get_and_head(hass: HomeAssistant, setup: Path, hass_client) -> None:
    client = await hass_client()
    assert (await client.get(URL)).status == 404
    data = b"glTF\x02\x00\x00\x00" + b"\x00" * 16
    setup.mkdir(parents=True)
    (setup / "default.glb").write_bytes(data)
    resp = await client.get(URL)
    assert resp.status == 200
    assert resp.headers["Content-Type"] == "model/gltf-binary"
    assert await resp.read() == data
    head = await client.head(URL)
    assert head.status == 200
    assert head.headers.get("ETag") or head.headers.get("Last-Modified")  # the card's cache version


async def test_read_only_and_valid_keys(hass: HomeAssistant, setup: Path, hass_client) -> None:
    client = await hass_client()
    assert (await client.post(URL, data=b"x")).status == 405
    assert (await client.delete(URL)).status == 405
    assert (await client.get("/api/floorplan3d/model/..%2Fsecrets")).status in (400, 404)


async def test_needs_login(hass: HomeAssistant, setup: Path, hass_client_no_auth) -> None:
    client = await hass_client_no_auth()
    assert (await client.get(URL)).status == 401
