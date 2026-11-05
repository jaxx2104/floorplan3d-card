// The subset of Home Assistant's frontend `hass` object this card uses. HA ships no public types for
// it, so this is the contract: extend it here (never inline) when the card starts reading something new.

export interface HassEntityAttributes {
  friendly_name?: string;
  device_class?: string;
  unit_of_measurement?: string;
  icon?: string;
  entity_picture?: string;
  brightness?: number;
  rgb_color?: [number, number, number];
  color_temp_kelvin?: number;
  /** The light's current colour mode (color_temp, hs, rgb, xy, brightness, onoff ...). */
  color_mode?: string;
  latitude?: number;
  longitude?: number;
  [key: string]: unknown;
}

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: HassEntityAttributes;
  last_changed: string;
  last_updated: string;
}

/** Entity registry display entry (`hass.entities`). */
export interface HassEntityRegistryEntry {
  entity_id: string;
  device_id?: string | null;
  area_id?: string | null;
  platform?: string;
  name?: string | null;
  original_name?: string | null;
  icon?: string | null;
  labels?: string[];
  hidden?: boolean;
  entity_category?: "config" | "diagnostic" | null;
  translation_key?: string;
}

export interface HassDevice {
  id: string;
  name?: string | null;
  name_by_user?: string | null;
  area_id?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  labels?: string[];
}

export interface HassArea {
  area_id: string;
  name: string;
  floor_id?: string | null;
  icon?: string | null;
  labels?: string[];
}

export interface HassFloor {
  floor_id: string;
  name: string;
  level?: number | null;
  icon?: string | null;
}

export interface HassLabel {
  label_id: string;
  name: string;
  color?: string | null;
  icon?: string | null;
}

export interface HassUser {
  id: string;
  name: string;
  is_admin: boolean;
  is_owner?: boolean;
}

export interface HassConfig {
  latitude: number;
  longitude: number;
  elevation?: number;
  time_zone: string;
  unit_system?: Record<string, string>;
  [key: string]: unknown;
}

export interface HassThemes {
  darkMode?: boolean;
  theme?: string;
  [key: string]: unknown;
}

export interface HassServiceTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
}

export interface Hass {
  states: Record<string, HassEntity>;
  entities: Record<string, HassEntityRegistryEntry>;
  devices: Record<string, HassDevice>;
  areas: Record<string, HassArea>;
  floors?: Record<string, HassFloor>;
  labels?: Record<string, HassLabel>;
  user?: HassUser;
  config: HassConfig;
  themes?: HassThemes;
  language?: string;
  callWS<T = unknown>(msg: {
    type: string;
    [key: string]: unknown;
  }): Promise<T>;
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: HassServiceTarget,
  ): Promise<unknown>;
  hassUrl(path?: string): string;
  /** HA's state text (translated, display precision, unit); frontend 2023.9+. */
  formatEntityState?(stateObj: HassEntity, state?: string): string;
  /** HA's attribute value text (translated, unit). */
  formatEntityAttributeValue?(
    stateObj: HassEntity,
    attribute: string,
    value?: unknown,
  ): string;
  fetchWithAuth(path: string, init?: RequestInit): Promise<Response>;
}
