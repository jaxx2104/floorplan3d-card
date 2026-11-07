// A small fake Home Assistant: registries, states, services, websocket, a mower driving circles.

const floors = {
  ground: { floor_id: "ground", name: "Ground floor", level: 0 },
  first: { floor_id: "first", name: "First floor", level: 1 },
};
const areaFloor = {
  living_room: "ground",
  hall: "ground",
  kitchen: "ground",
  bathroom: "ground",
  bedroom: "ground",
  utility: "ground",
  terrace: "ground",
  garden: "ground",
  garage: "ground",
  kids_room: "first",
  landing: "first",
  office: "first",
  master_bedroom: "first",
  bathroom_2: "first",
};
const pretty = (id) =>
  id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const areas = Object.fromEntries(
  Object.entries(areaFloor).map(([id, f]) => [
    id,
    { area_id: id, name: pretty(id), floor_id: f },
  ]),
);

const devices = {};
const entities = {};
// HA labels (label registry): entities carry label ids, names come from here (default object tags)
const labels = {
  outdoor: { label_id: "outdoor", name: "Outdoor", icon: "mdi:tree" },
};
const states = {};
function device(id, name, area, list) {
  devices[id] = { id, name, area_id: area };
  for (const [eid, state, attributes = {}, reg = {}] of list) {
    entities[eid] = { entity_id: eid, device_id: id, ...reg };
    states[eid] = {
      entity_id: eid,
      state: String(state),
      attributes: { friendly_name: name, ...attributes },
    };
  }
}
const temp = (v) => ({
  device_class: "temperature",
  unit_of_measurement: "°C",
  state: v,
});
const sensor = (eid, v, dc, unit) => [
  eid,
  v,
  { device_class: dc, unit_of_measurement: unit },
];
const light = (eid, on, brightness = 255, rgb) => [
  eid,
  on ? "on" : "off",
  on ? { brightness, ...(rgb ? { rgb_color: rgb } : {}) } : {},
];

device("living_ceiling", "Living ceiling", "living_room", [
  light("light.living_ceiling", true, 210, [255, 190, 120]),
]);
device("floor_lamp", "Floor lamp", "living_room", [
  light("light.floor_lamp", true, 150, [110, 130, 255]),
]);
device("living_climate", "Living climate", "living_room", [
  sensor("sensor.living_temperature", 21.4, "temperature", "°C"),
  sensor("sensor.living_humidity", 44, "humidity", "%"),
  sensor("sensor.living_battery", 87, "battery", "%").concat([
    { entity_category: "diagnostic" },
  ]),
]);
// album art as the TV's entity_picture (a marker with a picture)
const ART =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#6a3cff"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/><circle cx="20" cy="20" r="9" fill="#fff" opacity=".85"/><circle cx="20" cy="20" r="3" fill="#6a3cff"/></svg>',
  );
device("tv", "TV", "living_room", [
  ["media_player.tv", "playing", { entity_picture: ART }],
]);
device("living_motion", "Living motion", "living_room", [
  ["binary_sensor.living_motion", "off", { device_class: "motion" }],
]);
device("living_blinds", "Blinds", "living_room", [
  ["cover.living_blinds", "open"],
]);
device("living_window", "Terrace door", "living_room", [
  ["binary_sensor.terrace_door", "off", { device_class: "door" }],
]);

device("hall_light", "Hall light", "hall", [light("light.hall", false)]);
device("front_door", "Front door", "hall", [
  ["binary_sensor.front_door", "off", { device_class: "door" }],
]);
device("front_lock", "Front lock", "hall", [
  ["lock.front_door", "locked"],
  sensor("sensor.front_lock_battery", 12, "battery", "%").concat([
    { entity_category: "diagnostic" },
  ]),
]); // low battery badge
device("smoke_hall", "Smoke detector", "hall", [
  ["binary_sensor.smoke_hall", "unavailable", { device_class: "smoke" }],
]); // red status dot

device("kitchen_main", "Kitchen light", "kitchen", [
  light("light.kitchen", true, 255),
]);
device("kitchen_island", "Island light", "kitchen", [
  light("light.kitchen_island", false),
]);
device("kettle_plug", "Kettle plug", "kitchen", [
  ["switch.kettle", "off"],
  sensor("sensor.kettle_power", 0, "power", "W"),
  ["update.kettle_fw", "off"],
]);
device("kitchen_temp", "Kitchen sensor", "kitchen", [
  sensor("sensor.kitchen_temperature", 22.8, "temperature", "°C"),
  sensor("sensor.kitchen_humidity", 51, "humidity", "%"),
]);

device("bath_light", "Bathroom light", "bathroom", [
  light("light.bathroom", false),
]);
device("bath_fan", "Bathroom fan", "bathroom", [["fan.bathroom", "on"]]);
device("bath_humidity", "Bathroom humidity", "bathroom", [
  sensor("sensor.bathroom_humidity", 68, "humidity", "%"),
]);

device("bed_light", "Bedroom light", "bedroom", [
  light("light.bedroom", false),
]);
device("bed_climate", "Bedroom radiator", "bedroom", [
  ["climate.bedroom", "heat", { current_temperature: 20.5, temperature: 21 }],
]);
device("bed_window", "Bedroom window", "bedroom", [
  ["binary_sensor.bedroom_window", "on", { device_class: "window" }],
]);

device("boiler", "Boiler", "utility", [
  ["water_heater.boiler", "eco", { current_temperature: 54 }],
]);
device("washer", "Washer plug", "utility", [
  ["switch.washer", "on"],
  sensor("sensor.washer_power", 412, "power", "W"),
]);

device("terrace_light", "Terrace light", "terrace", [
  light("light.terrace", true, 180, [255, 160, 80]),
]);
device("outdoor_temp", "Outdoor sensor", "terrace", [
  sensor("sensor.outdoor_temperature", 9.6, "temperature", "°C"),
]);

device("mower", "Mower", "garden", [
  ["lawn_mower.demo", "mowing", { battery_level: 76 }],
  sensor("sensor.demo_mower_battery", 76, "battery", "%"),
  [
    "device_tracker.sunseeker_position",
    "not_home",
    { latitude: 45.0, longitude: 10.0 },
  ],
  ["binary_sensor.demo_mower_error", "off", { device_class: "problem" }],
]);
device("garden_cam", "Garden camera", "garden", [["camera.garden", "idle"]]);
device("robot", "Robo", null, [
  ["lawn_mower.robo", "mowing"],
  ["sensor.robo_progress", 39, { unit_of_measurement: "%" }],
  [
    "sensor.robo_battery",
    82,
    { device_class: "battery", unit_of_measurement: "%" },
  ],
  ["sensor.robo_errorcode", 0, { friendly_name: "Robo ErrorCode" }],
  ["binary_sensor.robo_online", "on", { device_class: "connectivity" }],
  ["sensor.robo_rain_sensor", "Dry", { friendly_name: "Robo Rain sensor" }],
  ["sensor.robo_rain_sensor_countdown", 0, { unit_of_measurement: "min" }],
  ["sensor.robo_wifi_strength", -61, { unit_of_measurement: "dBm" }],
  ["sensor.robo_robot_signal", 4],
  ["sensor.robo_cutterplate_time_left", 120, { unit_of_measurement: "h" }],
  ["sensor.robo_total_area", 512, { unit_of_measurement: "m²" }],
  ["sensor.robo_work_region", "Zone A"],
  ["sensor.robo_zone_a_area", 210, { unit_of_measurement: "m²" }],
  ["sensor.robo_zone_a_estimated_time", 100, { unit_of_measurement: "min" }],
  ["binary_sensor.robo_zone_a_started", "on"],
  ["binary_sensor.robo_zone_a_finished", "off"],
  ["sensor.robo_mower_status", "Working"],
  ["sensor.robo_work_records", 57],
]);
device("garage_door", "Garage door", "garage", [["cover.garage", "closed"]]); // no room drawn: not shown

device("kids_light", "Kids light", "kids_room", [
  light("light.kids", true, 90, [255, 120, 200]),
]);
device("kids_temp", "Kids sensor", "kids_room", [
  sensor("sensor.kids_temperature", 21.9, "temperature", "°C"),
]);
device("landing_light", "Landing light", "landing", [
  light("light.landing", false),
]);
device("landing_motion", "Landing motion", "landing", [
  ["binary_sensor.landing_motion", "on", { device_class: "motion" }],
]);
device("office_light", "Office light", "office", [
  light("light.office", true, 255, [230, 240, 255]),
]);
device("office_pc", "Office PC plug", "office", [
  ["switch.office_pc", "on"],
  sensor("sensor.office_pc_power", 138, "power", "W"),
]);
device("office_co2", "Office air", "office", [
  sensor("sensor.office_co2", 812, "carbon_dioxide", "ppm"),
  sensor("sensor.office_temperature", 23.1, "temperature", "°C"),
]);
device("master_light", "Master light", "master_bedroom", [
  light("light.master", false),
]);
device("bath2_light", "Bathroom 2 light", "bathroom_2", [
  light("light.bathroom_2", false),
]);
device("bath2_heater", "Floor heating", "bathroom_2", [
  ["climate.bathroom_2", "heat", { current_temperature: 24 }],
]);
// bound to the demo model's objects (demo/house.glb): with ?model=1 these have no markers, the model is the control
device("demo_living_lamp", "Living ceiling lamp", "living_room", [
  light("light.demo_living", true, 200, [255, 200, 140]),
]);
device("demo_hall_lamp", "Hall ceiling lamp", "hall", [
  light("light.demo_hall", false),
]);
// a smart bulb: colour, colour temperature and effects (the popup adds those rows from the capabilities)
device("demo_kitchen_lamp", "Kitchen ceiling lamp", "kitchen", [
  [
    "light.demo_kitchen",
    "on",
    {
      brightness: 255,
      supported_color_modes: ["hs", "color_temp"],
      color_mode: "color_temp",
      color_temp_kelvin: 3000,
      min_color_temp_kelvin: 2200,
      max_color_temp_kelvin: 6000,
      effect_list: ["Rainbow", "Music pulse", "Candle", "Sound reactive"],
      effect: null,
    },
  ],
]);
device("demo_strip", "Kitchen strip", "kitchen", [
  light("light.demo_strip", true, 150, [120, 200, 255]),
]);
device("demo_facade", "Facade lamps", "terrace", [
  [...light("light.demo_facade", true, 230), { labels: ["outdoor"] }],
]);
device("demo_facade_switch", "Facade switch", "hall", [
  ["switch.demo_facade", "on"],
]); // tag controller (layout.tags.facade)
device("demo_terrace_spot", "Terrace spot", "terrace", [
  [
    ...light("light.demo_terrace", true, 220, [255, 170, 90]),
    { labels: ["outdoor"] },
  ],
]);
device("demo_climate", "Living climate unit", "living_room", [
  [
    "climate.demo_living",
    "heat",
    {
      current_temperature: 21.5,
      temperature: 22,
      hvac_action: "heating",
      hvac_modes: ["off", "heat", "cool", "auto"],
    },
  ],
]);
device("demo_charger", "EV charger", "garden", [
  ["sensor.demo_charger", "charging", { power: 7.4, energy: 12.6 }],
]);
void temp;
// integration (platform) per entity for the logo badges; 'nobrand' has no logo (the badge stays hidden)
const PLATFORMS = {
  light: "hue",
  switch: "shelly",
  lock: "zwave_js",
  binary_sensor: "zha",
  fan: "shelly",
  media_player: "cast",
  climate: "tado",
  lawn_mower: "sunseeker",
  cover: "nobrand",
};
for (const [eid, e] of Object.entries(entities)) {
  const p = PLATFORMS[eid.split(".")[0]];
  if (p && !e.platform) e.platform = p;
  if (e.device_id === "front_lock") e.platform = "zwave_js";
}
// sensors from other integrations (edit-mode entity pickers show the integration)
entities["sensor.kettle_power"].platform = "sonoff";
entities["sensor.kitchen_temperature"].platform = "tuya";
// weather (no device, no marker): clouds and light follow cloud_coverage; ?clouds=60 starts cloudy
const demoClouds =
  Number(
    new URLSearchParams(
      typeof location !== "undefined" ? location.search : "",
    ).get("clouds"),
  ) || 0;
states["weather.demo"] = {
  entity_id: "weather.demo",
  state: demoClouds ? "partlycloudy" : "sunny",
  attributes: { friendly_name: "Demo weather", cloud_coverage: demoClouds },
};

// Headless checks reuse one page: stop the previous mock (its timer) before a new one.
let mockTimer = null;
export function resetMockHass() {
  clearInterval(mockTimer);
  mockTimer = null;
}

export function createMockHass({ onChange }) {
  let current;
  const make = (st) => ({
    states: st,
    entities,
    devices,
    areas,
    floors,
    labels,
    user: { name: "Demo", is_admin: true },
    config: { latitude: 52.0, longitude: 5.0, time_zone: "UTC" }, // generic location (moon position)
    language: "en",
    hassUrl: (p) => p,
    callService: async (domain, service, data = {}, target) => {
      (window.__serviceCalls = window.__serviceCalls || []).push(
        target ? [domain, service, data, target] : [domain, service, data],
      ); // headless checks
      (window.__serviceCallTimes = window.__serviceCallTimes || []).push(
        performance.now(),
      );
      const s = current.states[data.entity_id || (target && target.entity_id)];
      if (!s || !["toggle", "turn_on", "turn_off"].includes(service)) return;
      const on =
        service === "toggle" ? s.state !== "on" : service === "turn_on";
      const attrs = { ...s.attributes };
      if (s.entity_id.startsWith("light.")) {
        if (on)
          attrs.brightness =
            data.brightness ??
            (typeof data.brightness_pct === "number"
              ? Math.round((data.brightness_pct / 100) * 255)
              : (attrs.brightness ?? 255));
        else delete attrs.brightness;
        if (on && data.rgb_color) attrs.rgb_color = data.rgb_color;
        if (on && data.hs_color) {
          attrs.hs_color = data.hs_color;
          attrs.color_mode = "hs";
        }
        if (on && data.color_temp_kelvin) {
          attrs.color_temp_kelvin = data.color_temp_kelvin;
          attrs.color_mode = "color_temp";
        }
        if (on && data.effect) attrs.effect = data.effect;
      }
      update({
        [s.entity_id]: { ...s, state: on ? "on" : "off", attributes: attrs },
      });
    },
    callWS: async () => {
      throw { code: "unknown_command", message: "Unknown command." };
    },
  });
  const update = (changes) => {
    current = make({ ...current.states, ...changes });
    onChange(current);
  };
  current = make({ ...states });

  // mower drives a circle in the garden (~4 m radius)
  let t = 0;
  const step = (at) => {
    t = at ?? t + 0.06;
    const lat = 45.0 + (Math.sin(t) * 4) / 111320;
    const lon =
      10.0 + (Math.cos(t) * 4) / (111320 * Math.cos((45.0 * Math.PI) / 180));
    const s = current.states["device_tracker.sunseeker_position"];
    update({
      "device_tracker.sunseeker_position": {
        ...s,
        attributes: { ...s.attributes, latitude: lat, longitude: lon },
      },
    });
  };
  // headless checks hold it still and move it exactly one step with window.__demoMowerStep(), or to angle at
  window.__demoMowerStep = step;
  clearInterval(mockTimer);
  mockTimer = setInterval(() => {
    if (!window.__demoMowerPaused) step();
  }, 500);

  // headless checks: window.__setDemoStates({ entity_id: state | { state, attributes } })
  window.__setDemoStates = (changes) =>
    update(
      Object.fromEntries(
        Object.entries(changes).map(([eid, v]) => {
          const s = current.states[eid] || { entity_id: eid, attributes: {} };
          const nv = typeof v === "object" ? v : { state: v };
          return [
            eid,
            {
              ...s,
              state: String(nv.state ?? s.state),
              attributes: { ...s.attributes, ...nv.attributes },
              last_changed: nv.last_changed || new Date().toISOString(),
            },
          ];
        }),
      ),
    );

  // headless checks: window.__setDemoSun(elevation, azimuth) adds / updates sun.sun
  window.__setDemoSun = (elevation, azimuth) =>
    update({
      "sun.sun": {
        entity_id: "sun.sun",
        state: elevation > 0 ? "above_horizon" : "below_horizon",
        attributes: { elevation, azimuth },
      },
    });

  // headless checks: window.__setDemoWeather(coverage, condition) sets weather.demo (coverage null: condition only)
  window.__setDemoWeather = (coverage, condition = "partlycloudy") =>
    update({
      "weather.demo": {
        entity_id: "weather.demo",
        state: condition,
        attributes: {
          friendly_name: "Demo weather",
          ...(coverage === null || coverage === undefined
            ? {}
            : { cloud_coverage: coverage }),
        },
      },
    });

  return current;
}
