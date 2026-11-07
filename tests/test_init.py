"""Tests for the floorplan3d integration."""

from pathlib import Path

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from custom_components.floorplan3d.const import CARD_URL_BASE, DOMAIN


async def _setup(hass: HomeAssistant) -> None:
    """Set up through YAML, which imports a config entry."""
    assert await async_setup_component(hass, "http", {})
    assert await async_setup_component(hass, DOMAIN, {DOMAIN: {}})
    await hass.async_block_till_done()
    assert len(hass.config_entries.async_entries(DOMAIN)) == 1


async def test_no_layout_commands(hass: HomeAssistant, hass_ws_client) -> None:
    """The layout is the card YAML's: nothing is stored or served over the websocket."""
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "floorplan3d/layout/get", "key": "default"})
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "unknown_command"


async def test_serves_bundled_card(hass: HomeAssistant, hass_client) -> None:
    """The entry is loaded on every page; it and its chunks are served from frontend/, cacheable."""
    frontend = Path(__file__).parent.parent / "custom_components" / DOMAIN / "frontend"
    card = frontend / "floorplan3d-card.js"
    chunk = frontend / "chunks" / "card-impl-TEST1234.js"
    created = [p for p in (card, chunk) if not p.exists()]
    for p in created:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("console.log('card');")
    try:
        await _setup(hass)
        urls = hass.data["frontend_extra_module_url"].urls
        url = next(u for u in urls if "floorplan3d-card.js" in u)
        assert url.startswith(f"{CARD_URL_BASE}/floorplan3d-card.js?v=")
        assert not any("chunks/" in u for u in urls)  # chunks load on demand, not on every page
        client = await hass_client()
        for path in (url.split("?")[0], f"{CARD_URL_BASE}/chunks/{chunk.name}"):
            resp = await client.get(path)
            assert resp.status == 200, path
            assert "javascript" in resp.headers["Content-Type"]
            assert "max-age" in resp.headers.get("Cache-Control", ""), path
        resp = await client.get(f"{CARD_URL_BASE}/chunks/missing-0000.js")
        assert resp.status == 404
    finally:
        for p in created:
            p.unlink()
