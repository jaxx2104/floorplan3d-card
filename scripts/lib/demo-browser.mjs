// Shared by the headless checks: a static server for the repo and a Chrome page on the demo.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

export const root = path.resolve(import.meta.dirname, "../..");

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function findChrome() {
  const chrome =
    process.env.CHROME_PATH ||
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find((p) => fs.existsSync(p));
  if (!chrome) throw new Error("Chrome not found, set CHROME_PATH");
  return chrome;
}

// Static server + headless Chrome. Returns { browser, base, close }.
export async function launch() {
  const server = http
    .createServer((req, res) => {
      const file = path.join(
        root,
        decodeURIComponent(new URL(req.url, "http://x").pathname),
      );
      if (
        !file.startsWith(root) ||
        !fs.existsSync(file) ||
        fs.statSync(file).isDirectory()
      ) {
        res.writeHead(404).end();
        return;
      }
      // validators like a real static server (the card's model cache versions URL models by them)
      const st = fs.statSync(file);
      res.writeHead(200, {
        "content-type": types[path.extname(file)] || "application/octet-stream",
        "content-length": st.size,
        etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
        "last-modified": st.mtime.toUTCString(),
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      fs.createReadStream(file).pipe(res);
    })
    .listen(0);
  // Chrome's start is environment setup, not a check: a loaded runner can take longer than puppeteer's 30 s to
  // print the WS endpoint, so a generous timeout and one relaunch
  const start = () =>
    puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      timeout: 120000,
      args: [
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    });
  let browser;
  try {
    browser = await start();
  } catch (e) {
    console.log(`     (Chrome did not start: ${e.message}; once more)`);
    try {
      browser = await start();
    } catch (e2) {
      server.closeAllConnections();
      server.close();
      throw e2;
    }
  }
  const close = async () => {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }; // no keep-alive socket holds the process
  return { browser, base: `http://localhost:${server.address().port}`, close };
}

// A page that records errors and console warnings (GPU driver chatter excluded).
export async function newPage(
  browser,
  viewport = { width: 1400, height: 560 },
) {
  const errors = [];
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      ["error", "warn", "warning"].includes(m.type()) &&
      !m.location().url?.endsWith("favicon.ico") &&
      !m.location().url?.startsWith("https://brands.home-assistant.io/") &&
      !m.text().includes("GL Driver Message")
    )
      errors.push(m.type() + ": " + m.text());
  });
  await page.setViewport({ deviceScaleFactor: 1, ...viewport });
  return { page, errors };
}

// Integration logos without the network: brands.home-assistant.io answered with a test badge (an SVG
// with the platform's initial); platform "nobrand" 404s (badge hidden), shelly has no dark_icon (fallback).
export const brandRequests = [];
const BRAND_COLORS = {
  hue: "#1e88e5",
  shelly: "#00897b",
  zwave_js: "#6d4c41",
  zha: "#8e24aa",
  cast: "#e53935",
  tado: "#fb8c00",
  sunseeker: "#43a047",
};
export async function interceptBrands(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const m =
      /^https:\/\/brands\.home-assistant\.io\/_\/([^/]+)\/(icon|dark_icon)\.png/.exec(
        req.url(),
      );
    if (!m) {
      req.continue();
      return;
    }
    const [, platform, kind] = m;
    brandRequests.push(`${platform}/${kind}`);
    if (
      platform === "nobrand" ||
      (platform === "shelly" && kind === "dark_icon")
    ) {
      req.respond({
        status: 404,
        contentType: "text/plain",
        headers: { "access-control-allow-origin": "*" }, // as the real server (the card loads logos with CORS)
        body: "not found",
      });
      return;
    }
    const fill = BRAND_COLORS[platform] || "#757575",
      fg = kind === "dark_icon" ? "#111" : "#fff";
    req.respond({
      status: 200,
      contentType: "image/svg+xml",
      headers: { "access-control-allow-origin": "*" },
      body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${fill}"/><text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="${fg}">${platform[0].toUpperCase()}</text></svg>`,
    });
  });
}

// demo/index.html?query; test mode (?test=1, cheaper rendering) unless test is false.
export function demoUrl(base, query = {}, { test = true } = {}) {
  const q = new URLSearchParams(
    Object.entries({ ...(test ? { test: "1" } : {}), ...query }).filter(
      ([, v]) => v !== undefined,
    ),
  );
  return `${base}/demo/index.html?${q}`;
}

// Every floorplan3d-card shell has loaded its card (the lazy import of the card chunk), markers on the
// first card and two rendered frames after that. The checks then work on the floorplan3d-card-impl
// elements (the shells' children), where the card's internals and shadow root are.
export async function waitForDemo(page) {
  await page.waitForFunction(
    () => {
      const shells = [...document.querySelectorAll("floorplan3d-card")];
      if (
        !shells.length ||
        !shells.every((s) => s.querySelector(":scope > floorplan3d-card-impl"))
      )
        return false;
      const c = document.querySelector("floorplan3d-card-impl");
      return (
        c &&
        c.shadowRoot &&
        c._view &&
        c._view.markerObjects.size > 0 &&
        c._view.stats.frames > 0
      );
    },
    { timeout: 30000 },
  ); // a loaded machine can take > 10 s for the first frame
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

// Settled: after at least two animation frames, the first card has nothing left to do: no camera tween, no
// frame due, no card update, surface search or tap decision pending, no edit-panel render queued, no layout
// save waiting on its debounce. -> true, false after timeout ms (the checks then report it).
export const idle = (page, timeout = 10000) =>
  page.evaluate(`new Promise((done) => {
  const t0 = performance.now();
  let n = 0;
  const tick = () => {
    const c = document.querySelector("floorplan3d-card-impl"), v = c && c._view, e = c && c._edit, s = c && c._store;
    const ok = ++n > 2 && (!v || (!v._tween && !v.dirty && !c._pending && !c._surfJob && !(c._taps && c._taps.pending.size)
      && !(e && e._renderQueued) && !(s && s._pending)));
    if (ok || performance.now() - t0 > ${timeout}) done(ok); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`);

// Opens the demo and waits for markers. Returns { page, errors, close, browser, base }.
// opts.brands: answer integration logo requests locally (interceptBrands); opts.test: false = real look.
export async function openDemo(
  query = {},
  viewport = { width: 1400, height: 560 },
  opts = {},
) {
  const { browser, base, close } = await launch();
  try {
    const { page, errors } = await newPage(browser, viewport);
    if (opts.brands) await interceptBrands(page);
    await page.goto(demoUrl(base, query, { test: opts.test !== false }), {
      waitUntil: "load",
      timeout: 120000,
    });
    await waitForDemo(page);
    return { page, errors, close, browser, base };
  } catch (e) {
    await close();
    throw e;
  }
}
