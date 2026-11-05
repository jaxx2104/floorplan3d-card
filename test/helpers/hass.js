// Builders for Home Assistant state objects (hass.states values).

/** A state without an entity id: { state, attributes }. */
export const st = (state, attributes = {}) => ({ state, attributes });

/** A full state object: { entity_id, state, attributes }. */
export const stateOf = (entity_id, state, attributes = {}) => ({
  entity_id,
  state,
  attributes,
});
