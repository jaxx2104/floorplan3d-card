// How the card fetches its model: Home Assistant API paths with the user's token, other URLs as they are.
import { describe, it, expect, vi, afterEach } from "bun:test";
import { ModelLoader } from "../src/card/model-loader.ts";

const loader = (hass) => new ModelLoader({ _hass: hass });

describe("_modelFetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  it("an /api/ path goes through hass.fetchWithAuth (the integration serves logged-in users only)", async () => {
    const fetchWithAuth = vi.fn(async () => new Response("x"));
    globalThis.fetch = vi.fn();
    const get = loader({ fetchWithAuth })._modelFetch(
      "/api/floorplan3d/model/default",
      "http://ha/api/floorplan3d/model/default",
    );
    await get({ method: "HEAD" });
    expect(fetchWithAuth).toHaveBeenCalledWith(
      "/api/floorplan3d/model/default",
      { method: "HEAD" },
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("/local/ and other URLs are plain same-origin fetches", async () => {
    const fetchWithAuth = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response("x"));
    await loader({ fetchWithAuth })._modelFetch(
      "/local/house.glb",
      "http://ha/local/house.glb",
    )();
    expect(globalThis.fetch).toHaveBeenCalledWith("http://ha/local/house.glb", {
      credentials: "same-origin",
    });
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
