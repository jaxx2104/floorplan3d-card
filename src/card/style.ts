// The card's shadow DOM styles (markers, popup, toolbar, edit panel).
export const STYLE: string = `
  :host { display: block; }
  ha-card { display: block; overflow: hidden; position: relative; container-type: inline-size;
    background: var(--ha-card-background, var(--card-background-color, #fff));
    border-radius: var(--ha-card-border-radius, 12px); color: var(--primary-text-color); }
  .stage { position: relative; width: 100%; touch-action: none; user-select: none; -webkit-user-select: none; }
  .stage canvas { display: block; }
  .toolbar { position: absolute; top: 8px; left: 8px; right: 8px; display: flex; gap: 8px;
    align-items: flex-start; z-index: 2; pointer-events: none; }
  .toolbar > * { pointer-events: auto; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
  .spacer { flex: 1; }
  button.chip, .seg button { font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
    padding: 7px 12px; border-radius: 16px; border: 1px solid var(--divider-color, rgba(0,0,0,.12));
    background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  button.chip.on, .seg button.on { background: var(--primary-color); border-color: var(--primary-color);
    color: var(--text-primary-color, #fff); }
  .seg { display: flex; }
  .seg button:first-child { border-radius: 16px 0 0 16px; }
  .seg button:last-child { border-radius: 0 16px 16px 0; border-left: none; }
  .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 24px; color: var(--secondary-text-color); pointer-events: none; }
  .empty[hidden], .notice[hidden] { display: none; }
  .notice { position: absolute; left: 8px; bottom: 8px; right: 8px; padding: 6px 10px; border-radius: 6px; font-size: 12px;
    background: var(--card-background-color, #fff); color: var(--error-color, #db4437);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); pointer-events: none; }

  .fp-room-label { font-size: 11px; letter-spacing: .02em; color: var(--secondary-text-color, #727272);
    white-space: nowrap; pointer-events: none; opacity: .9; }
  .fp-room-label.outdoor { font-style: italic; }
  .fp-attach-label { font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; pointer-events: none;
    transform: translateY(-22px); background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  /* the marker box is just the dot (CSS2D centres the box on the 3D point); the value hangs below it */
  .fp-marker { position: relative; display: flex; flex-direction: column; align-items: center; pointer-events: auto;
    cursor: pointer; transform-origin: center; }
  .fp-dot { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: var(--card-background-color, #fff); color: var(--secondary-text-color, #727272);
    border: 1.5px solid var(--divider-color, rgba(0,0,0,.15)); box-shadow: 0 1px 4px rgba(0,0,0,.25);
    transition: background .2s, color .2s, transform .1s; --mdc-icon-size: 17px; }
  .fp-marker:hover .fp-dot { transform: scale(1.12); }
  /* --fp-state: HA's state colour (registry.ts markerColor), --fp-light: the light's own colour */
  .fp-marker.active .fp-dot { background: var(--fp-state, var(--primary-color)); border-color: var(--fp-state, var(--primary-color));
    color: var(--text-primary-color, #fff); }
  .fp-marker.active.light .fp-dot { background: var(--fp-light, var(--fp-state, #ffb74d));
    border-color: var(--fp-light, var(--fp-state, #ffb74d)); color: #fff; }
  .fp-marker.unavailable .fp-dot { opacity: .45; border-style: dashed; }
  .fp-marker.offline .fp-dot { opacity: .5; filter: grayscale(1); }
  .fp-mower-chip { display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px 1px 4px; border-radius: 10px; font-size: 11px; font-weight: 600;
    white-space: nowrap; pointer-events: none; transform: translate(20px, -18px); box-shadow: 0 1px 3px rgba(0,0,0,.35);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); --mdc-icon-size: 14px; }
  .fp-mower-chip.offline { color: var(--secondary-text-color, #727272); }
  .fp-mower-chip.rain, .fp-mower-chip.drying { color: #1e88e5; }
  .fp-marker.fp-occluded { opacity: .25; pointer-events: none; }
  .editing .fp-marker.fp-occluded { opacity: .5; pointer-events: auto; }
  .body:not(.editing) .stage.night-quiet:not(.awake) .fp-marker:not(.alert-red):not(.alert-yellow) { opacity: 0; pointer-events: none; }
  .fp-val { position: absolute; top: calc(100% + 2px); left: 50%; transform: translateX(-50%);
    font-size: 10.5px; font-weight: 500; padding: 1px 5px; border-radius: 8px; white-space: nowrap;
    background: var(--card-background-color, #fff); color: var(--primary-text-color);
    box-shadow: 0 1px 3px rgba(0,0,0,.2); }
  .fp-val:empty { display: none; }
  /* marker shapes by role (registry.js markerLook) */
  .fp-dot { position: relative; }
  .fp-marker.shape-square .fp-dot { border-radius: 7px; }
  .fp-marker.shape-diamond .fp-dot { border-radius: 4px; transform: rotate(45deg) scale(.9); }
  .fp-marker.shape-diamond .fp-dot > :is(ha-icon, ha-state-icon) { transform: rotate(-45deg); }
  .fp-marker.shape-diamond:hover .fp-dot { transform: rotate(45deg) scale(1.02); }
  .fp-marker.alert-red .fp-dot { background: var(--fp-state, #e53935); border-color: var(--fp-state, #e53935); color: #fff; }
  .fp-marker.alert-yellow .fp-dot { background: var(--fp-state, #fbc02d); border-color: var(--fp-state, #fbc02d); color: #212121; }
  .fp-in:empty { display: none; }
  .fp-marker.kind-value .fp-dot { width: auto; min-width: 28px; padding: 0 6px 0 4px; gap: 2px; --mdc-icon-size: 13px; }
  .fp-marker.kind-value .fp-in { font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--primary-text-color); line-height: 1; }
  .fp-marker.kind-value.active .fp-in { color: inherit; }
  .fp-marker.kind-info .fp-dot::after { content: 'i'; position: absolute; top: -4px; left: -4px; width: 10px; height: 10px; border-radius: 50%;
    font: italic 700 8px/10px Georgia, serif; text-align: center; color: var(--card-background-color, #fff); background: var(--secondary-text-color, #727272); }
  .fp-dot > img.fp-pic { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; display: none; }
  .fp-dot.has-pic > img.fp-pic { display: block; }
  .fp-dot.has-pic > :is(ha-icon, ha-state-icon) { visibility: hidden; }
  .fp-marker.kind-picture .fp-dot { overflow: hidden; padding: 0; }
  /* device badges: integration logo (top right), status dot (bottom right), low battery chip (above) */
  .fp-marker > .fp-logo { position: absolute; top: -6px; right: -8px; width: 14px; height: 14px; box-sizing: border-box; padding: 1px;
    object-fit: contain; border-radius: 4px; background: var(--card-background-color, #fff); box-shadow: 0 0 0 1px var(--divider-color, rgba(0,0,0,.15)), 0 1px 2px rgba(0,0,0,.25); pointer-events: none; }
  .fp-status { display: inline-block; width: 7px; height: 7px; border-radius: 50%; box-sizing: content-box;
    border: 1.5px solid var(--card-background-color, #fff); background: #9e9e9e; pointer-events: none; }
  .fp-marker > .fp-status { position: absolute; right: -1px; bottom: -1px; }
  .fp-status[data-status="green"] { background: #43a047; }
  .fp-status[data-status="grey"] { background: #9e9e9e; }
  .fp-status[data-status="red"] { background: #e53935; }
  .fp-status[data-status="yellow"] { background: #fbc02d; }
  .fp-batt { position: absolute; bottom: calc(100% + 1px); left: 50%; transform: translateX(-50%); font-size: 9.5px; font-weight: 700; line-height: 13px;
    padding: 0 4px; border-radius: 7px; white-space: nowrap; background: #fbc02d; color: #212121; box-shadow: 0 1px 2px rgba(0,0,0,.35); pointer-events: none; }
  .fp-pop-badges { display: inline-flex; align-items: center; gap: 4px; }
  .fp-pop-badges:empty { display: none; }
  .fp-pop-badges .fp-logo { width: 16px; height: 16px; object-fit: contain; }
  .fp-popup { position: absolute; left: 0; top: 0; z-index: 3; min-width: 190px; max-width: 260px; padding: 8px 10px 10px;
    box-sizing: border-box; overflow: auto;
    border-radius: 12px; background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); box-shadow: 0 4px 16px rgba(0,0,0,.28); font-size: 13px;
    touch-action: manipulation; user-select: none; -webkit-user-select: none; }
  .fp-pop-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .fp-pop-title { flex: 1; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fp-pop-x { border: none; background: none; color: var(--secondary-text-color); font-size: 18px; line-height: 1;
    cursor: pointer; padding: 2px 4px; }
  .fp-pop-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
  .fp-pop-label { flex: 1; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fp-pop-row.chain { border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); margin-top: 4px; padding-top: 4px; }
  .fp-pop-row.chain .fp-pop-label { color: var(--primary-text-color); }
  .fp-pop-row.reason { font-size: 12px; color: var(--secondary-text-color); font-style: italic; min-height: 0; padding-top: 4px; }
  .fp-pop-row.brightness .fp-pop-label { flex: none; }
  .fp-pop-row.brightness input { flex: 1; min-width: 0; accent-color: var(--primary-color); }
  .fp-pop-row.brightness.off input { opacity: .5; }
  .fp-pop-row.brightness { flex-wrap: wrap; }
  .fp-presets { display: flex; gap: 4px; width: 100%; }
  .fp-presets button, .fp-pop-row.effect select { font: inherit; font-size: 12px; padding: 3px 4px; border-radius: 10px; cursor: pointer;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .fp-presets button { flex: 1; min-width: 0; }
  .fp-pop-row.effect select { flex: 1; min-width: 0; max-width: 150px; }
  .fp-pop-row.color_temp { flex-wrap: wrap; }
  .fp-pop-row.color_temp .fp-pop-label { flex: none; }
  .fp-pop-row.color_temp .fp-pop-value { flex: 1; text-align: right; }
  .fp-kelvin { width: 100%; height: 10px; margin: 4px 0; border-radius: 5px; -webkit-appearance: none; appearance: none; touch-action: none;
    background: linear-gradient(90deg, #ffa43c, #ffe2b8 45%, #fff 60%, #cfe0ff); }
  .fp-kelvin::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: var(--card-background-color, #fff);
    border: 2px solid var(--primary-color); }
  .fp-kelvin::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--card-background-color, #fff); border: 2px solid var(--primary-color); }
  .fp-wheel-box { position: relative; width: 132px; height: 132px; flex: none; }
  canvas.fp-wheel { display: block; border-radius: 50%; touch-action: none; cursor: crosshair; }
  .fp-wheel-dot { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; box-sizing: border-box;
    border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.5); pointer-events: none; }
  .fp-wheel-dot[hidden] { display: none; }
  .fp-pop-row.color { flex-wrap: wrap; gap: 8px; padding: 4px 0; align-items: flex-end; }
  .fp-swatch { width: 22px; height: 22px; border-radius: 50%; padding: 0; cursor: pointer;
    border: 1.5px solid var(--divider-color, rgba(0,0,0,.15)); }
  .fp-swatch.on { outline: 2px solid var(--primary-color); outline-offset: 1px; }
  .fp-swatch.white { background: #ffd9a8; }
  .fp-switch { width: 36px; height: 20px; border-radius: 10px; border: none; padding: 2px; cursor: pointer; flex: none;
    background: var(--switch-unchecked-track-color, rgba(127,127,127,.45)); display: flex; transition: background .15s; }
  .fp-switch span { width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3);
    transition: transform .15s; }
  .fp-switch.on { background: var(--primary-color); }
  .fp-switch.on span { transform: translateX(16px); }
  .fp-pop-value { font-weight: 500; }
  .fp-pop-btns { display: flex; gap: 6px; }
  .fp-pop-row.link { min-height: 26px; }
  .fp-pop-row:not(.link) + .fp-pop-row.link { border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); margin-top: 4px; padding-top: 4px; }
  .fp-pop-link { border: none; background: none; padding: 2px 0; font: inherit; color: var(--primary-color); cursor: pointer; }
  .fp-debug { position: absolute; left: 8px; bottom: 8px; z-index: 4; pointer-events: none; white-space: pre; font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--primary-text-color, #212121); background: color-mix(in srgb, var(--card-background-color, #fff) 82%, transparent);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); border-radius: 6px; padding: 4px 6px; }
  .fp-pop-btns button { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 12px; cursor: pointer;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .body { display: flex; }
  .body .stage { flex: 1; min-width: 0; }
  .panel { display: none; width: 300px; flex: none; box-sizing: border-box; flex-direction: column; max-height: var(--fp-height);
    border-left: 1px solid var(--divider-color, rgba(0,0,0,.12)); font-size: 13px; }
  .editing .panel { display: flex; }
  /* narrow cards (e.g. a sections-view column): plan on top, panel below */
  @container (max-width: 640px) {
    .body.editing { flex-direction: column; }
    .body.editing .stage { flex: none; width: 100%; }
    .editing .panel { width: auto; max-height: 420px; border-left: none; border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  }
  .tabs { display: flex; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  .panel .tabs button { flex: 1; border-radius: 0; font: inherit; padding: 10px 4px; background: none; border: none; cursor: pointer;
    color: var(--secondary-text-color); border-bottom: 2px solid transparent; }
  .panel .tabs button.on { color: var(--primary-color); border-bottom-color: var(--primary-color); }
  .tab-body { flex: 1; overflow: auto; padding: 4px 12px 12px; }
  .foot { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 11px;
    color: var(--secondary-text-color); border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); }
  .panel h3 { margin: 4px 0 6px; font-size: 14px; font-weight: 500; }
  .panel .sub { margin: 14px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--secondary-text-color); }
  .panel .hint, .panel .dim { color: var(--secondary-text-color); }
  .panel .hint { font-size: 12px; line-height: 1.4; }
  .panel p { margin: 6px 0; }
  .panel .box { border: 1px solid var(--divider-color, rgba(0,0,0,.12)); border-radius: 8px; padding: 8px 10px;
    margin: 8px 0; }
  .panel label { display: flex; flex-direction: column; gap: 3px; margin: 6px 0; font-size: 12px;
    color: var(--secondary-text-color); }
  .panel label.check { flex-direction: row; align-items: center; gap: 6px; color: var(--primary-text-color); }
  .panel select, .panel input[type=number] { font: inherit; padding: 5px 6px; border-radius: 6px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); min-width: 0; }
  .panel button, .panel label.button { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: inline-block; margin: 0; }
  .panel button:disabled { opacity: .45; cursor: default; }
  .panel button.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .panel button.danger { color: var(--error-color, #db4437); }
  .panel button.link { border: none; background: none; padding: 0 2px; color: var(--primary-color); }
  .panel .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .panel ul { list-style: none; margin: 0; padding: 0; }
  .panel ul.list li { display: flex; align-items: center; gap: 6px; padding: 4px 0;
    border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.06)); }
  .panel ul.list li.sel .name { color: var(--primary-color); font-weight: 500; }
  .panel .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .panel .pill { font-size: 10.5px; padding: 1px 7px; border-radius: 9px; }
  .panel .pill.ok { background: rgba(76,175,80,.16); color: var(--success-color, #43a047); }
  .panel tr.sel td { background: rgba(3,169,244,.12); }
  .stage.picking .fp-marker, .stage.picking .fp-handle { pointer-events: none; opacity: .45; }
  .panel details.report { margin: 6px 0; font-size: 12px; }
  .panel details.report summary { cursor: pointer; color: var(--secondary-text-color); }
  .panel details.report ul, .panel .msg { user-select: text; -webkit-user-select: text; cursor: text; }
  .panel .pill.missing { background: rgba(255,152,0,.16); color: var(--warning-color, #ef8a00); }
  .panel table.floors { width: 100%; border-collapse: collapse; font-size: 12px; }
  .panel table.floors th { font-weight: normal; color: var(--secondary-text-color); text-align: left; font-size: 11px; }
  .panel table.floors td { padding: 2px 3px 2px 0; }
  .panel table.floors input { width: 64px; }
  .panel .note { padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.4; }
  .panel .note.ok { background: rgba(76,175,80,.12); }
  .panel .note.warn { background: rgba(255,152,0,.14); }
  .panel .msg { margin: 8px 0; padding: 6px 10px; border-radius: 6px; background: rgba(76,175,80,.12); font-size: 12px; }
  .panel .msg.warn { background: rgba(255,152,0,.14); }
  .panel .msg.error { background: rgba(219,68,55,.14); color: var(--error-color, #db4437); }
  button.edit { font: inherit; font-size: 13px; line-height: 1; cursor: pointer; padding: 6px 10px; border-radius: 16px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: flex; align-items: center; gap: 4px; --mdc-icon-size: 16px; }
  button.edit[hidden], button.daynight[hidden], button.section[hidden] { display: none; }
  button.section.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.reset, button.section { font: inherit; line-height: 1; cursor: pointer; padding: 5px 8px; border-radius: 16px; display: flex;
    align-items: center; border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); --mdc-icon-size: 17px; }
  button.daynight { font: inherit; font-size: 15px; line-height: 1; cursor: pointer; padding: 5px 10px; border-radius: 16px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: flex; align-items: center; --mdc-icon-size: 17px; }
  button.suntime { font: inherit; font-size: 12px; line-height: 1; cursor: pointer; padding: 5px 8px; border-radius: 16px; gap: 4px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: flex; align-items: center; --mdc-icon-size: 15px; }
  button.suntime[hidden], .fp-suntime[hidden] { display: none; }
  button.suntime.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .fp-suntime { position: absolute; top: 46px; right: 8px; z-index: 6; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    border-radius: 12px; background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); box-shadow: 0 2px 8px rgba(0,0,0,.2); font-size: 13px; }
  .fp-suntime input { width: min(220px, 50vw); accent-color: var(--primary-color); }
  .fp-suntime .time { font-variant-numeric: tabular-nums; min-width: 3em; }
  .fp-suntime button { font: inherit; cursor: pointer; padding: 3px 10px; border-radius: 12px; border: 1px solid var(--divider-color, rgba(0,0,0,.12));
    background: transparent; color: var(--primary-text-color); }
  .editing button.edit { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }

  .fp-handle { box-sizing: border-box; width: 13px; height: 13px; border-radius: 50%; pointer-events: auto; cursor: grab;
    background: var(--card-background-color, #fff); border: 2px solid var(--primary-color, #03a9f4); touch-action: none; }
  .fp-handle.mid { width: 9px; height: 9px; opacity: .75; border-width: 1.5px; }
  .fp-handle.door { width: 11px; height: 11px; border-radius: 2px; background: var(--primary-color, #03a9f4);
    pointer-events: none; }
  .fp-handle.draw { pointer-events: none; width: 9px; height: 9px; }
  .fp-handle.draw.first { width: 15px; height: 15px; background: var(--primary-color, #03a9f4); }
  .fp-handle.cursor { pointer-events: none; width: 7px; height: 7px; border: none; background: var(--primary-color, #03a9f4); }
  .fp-handle.cursor.vertex { width: 15px; height: 15px; background: none; border: 2px solid var(--primary-color, #03a9f4); }
  .fp-handle.cursor.align { width: 9px; height: 9px; }
  .editing .fp-marker { cursor: grab; }
  .stage.drawing { cursor: crosshair; }
  .stage.drawing .fp-marker { pointer-events: none; opacity: .4; }
  .stage.drawing .fp-handle { pointer-events: none; }
  .stage.moving { cursor: move; }
  .stage.moving .fp-marker, .stage.moving .fp-handle { pointer-events: none; }
  .panel input[type=range] { width: 100%; margin: 0; accent-color: var(--primary-color); }
  .panel label .lab { display: flex; justify-content: space-between; }
  .panel label .val { color: var(--primary-text-color); }
  .panel label.slider .slrow { display: flex; align-items: center; gap: 6px; }
  .panel label.slider .slrow input[type=range] { flex: 1; min-width: 0; }
  .panel input.slnum { width: 62px; flex: none; font: inherit; font-size: 12px; padding: 3px 4px; border-radius: 6px; box-sizing: border-box;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .panel label.slider .unit { flex: none; min-width: 10px; font-size: 12px; color: var(--secondary-text-color); }
  .panel label.button.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .panel label.button.disabled { opacity: .6; pointer-events: none; }
  .panel .bad { color: var(--error-color, #db4437); }
  .panel code { font-size: 11px; }
  .panel .tabs button { padding: 10px 2px; font-size: 12.5px; }
  .panel input:not([type]), .panel input[list] { font: inherit; padding: 5px 6px; border-radius: 6px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); min-width: 0; }
  .panel .row label { flex: 1; }
  .panel .lg { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }
  .panel .lg .fp-logo { width: 16px; height: 16px; object-fit: contain; }
  .panel .entin { position: relative; display: block; }
  .panel .entin .lg { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); pointer-events: none; }
  .panel .entin > input { width: 100%; box-sizing: border-box; padding-left: 28px; }
  .fp-marker.selected .fp-dot { outline: 3px solid var(--primary-color, #03a9f4); outline-offset: 2px; }
  .has-model .fp-dot { width: 22px; height: 22px; --mdc-icon-size: 14px;
    background: color-mix(in srgb, var(--card-background-color, #fff) 85%, transparent); }
  .fp-marker.fp-faded { opacity: .3; }
  .compact .fp-dot { width: 21px; height: 21px; --mdc-icon-size: 13px; border-width: 1px; }
  .compact .fp-val { font-size: 9.5px; padding: 0 4px; }
  .has-model .fp-marker.kind-value .fp-dot { width: auto; min-width: 22px; padding: 0 5px 0 3px; }
  .compact .fp-marker.kind-value .fp-dot { width: auto; min-width: 21px; padding: 0 4px 0 2px; --mdc-icon-size: 11px; }
  .compact .fp-marker.kind-value .fp-in { font-size: 9.5px; }
  .stage.picking-views { cursor: pointer; }
  .stage.fp-hover canvas { cursor: pointer; }
  .panel details.advanced { margin: 12px 0 4px; }
  .panel details.advanced summary { cursor: pointer; color: var(--secondary-text-color); font-size: 12px; }
  .panel .floor-links { display: flex; flex-wrap: wrap; gap: 0 12px; }
  .panel .floor-links label.check { margin: 3px 0; }
  .panel ul.vtree li { display: flex; align-items: center; gap: 4px; padding: 1px 0 1px calc(var(--d, 0) * 14px);
    border-radius: 4px; min-height: 26px; }
  .panel ul.vtree li .name { font-size: 12.5px; }
  .panel ul.vtree li.off .name, .panel ul.vtree li.off .state { opacity: .45; }
  .panel ul.vtree li.lvl > .name { font-weight: 500; }
  .panel ul.vtree li.picked { background: rgba(3,169,244,.12); }
  .panel ul.vtree .state { --mdc-icon-size: 15px; color: var(--secondary-text-color); display: flex; }
  .panel ul.vtree button.eye { padding: 2px 5px; display: flex; align-items: center; --mdc-icon-size: 16px; line-height: 1; }
  .panel ul.vtree button.eye.shown { color: var(--primary-color); border-color: var(--primary-color); }
  .panel ul.vtree button.eye.hidden { color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
  .panel ul.vtree button.eye.default { opacity: .7; }
  .panel ul.otree { list-style: none; margin: 4px 0; padding: 0; }
  .panel ul.otree li.room { display: flex; align-items: center; gap: 4px; padding: 2px 0 2px calc(var(--d, 0) * 14px); font-size: 12.5px; }
  .panel ul.otree li.lvl { font-weight: 500; }
  .panel ul.otree li.obj { padding: 4px 6px; margin: 2px 0 2px 28px; border-radius: 6px; border: 1px solid var(--divider-color); }
  .panel ul.otree li.obj.sel { background: rgba(3,169,244,.12); border-color: var(--primary-color); }
  .panel ul.otree li.obj.hid .name { opacity: .5; }
  .panel ul.otree li.obj .orow { display: flex; align-items: center; gap: 6px; --mdc-icon-size: 16px; margin-bottom: 3px; }
  .panel ul.otree li.obj .orow .name { flex: 1; font-size: 12.5px; }
  .panel ul.otree li.obj .orow label.check { margin: 0; font-size: 12px; }
  .panel ul.otree li.obj .oacts { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 4px; }
  .panel ul.otree li.obj .oacts label.act { display: flex; flex-direction: column; margin: 0; font-size: 11px; color: var(--secondary-text-color); flex: 1; min-width: 80px; }
  .panel ul.otree li.obj .oacts select { font-size: 12px; }
  .panel ul.otree li.obj > input[name=obj-act-field] { margin-top: 3px; }
  .panel .otagbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 4px 0 6px; font-size: 12px; }
  .panel .otagbar label { margin: 0; font-size: 12px; }
  .panel .otagbar input.tagadd { width: 90px; }
  .panel ul.otree li.obj .opick { margin: 0; }
  .panel label.owash { display: flex; align-items: center; gap: 6px; margin: 3px 0 0; font-size: 12px; }
  .panel label.owash select { font-size: 12px; }
  .panel ul.otree li.obj .otags { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; margin-top: 3px; }
  .panel ul.otree li.obj .otag { display: inline-flex; align-items: center; gap: 2px; font-size: 11px; padding: 0 2px 0 6px; border-radius: 9px;
    background: var(--secondary-background-color, rgba(127,127,127,.2)); color: var(--primary-text-color); }
  .panel ul.otree li.obj .otag button { padding: 0 4px; font-size: 12px; line-height: 1; color: var(--secondary-text-color); }
  .panel ul.otree li.obj .otags input.tagadd { width: 70px !important; font-size: 11px; padding: 1px 4px; }
  .panel ul.otree li.obj > .badge.warn { display: block; margin-top: 3px; white-space: normal; }
  .panel ul.otree li.obj input[type=text], .panel ul.otree li.obj input:not([type]) { width: 100%; box-sizing: border-box; }
  .panel ul.otree .badge { font-size: 9.5px; padding: 0 4px; border-radius: 4px; background: var(--secondary-background-color, rgba(127,127,127,.2)); color: var(--secondary-text-color); }
  .panel ul.otree .badge.warn { background: none; color: var(--error-color, #db4437); border: 1px solid currentColor; }
  .panel ul.otree li.flash { animation: fp-flash 1.2s ease-out; }
  .panel ul.vtree li.flash { animation: fp-flash 1.2s ease-out; }
  .panel .chips.colors { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 2px 0 6px; font-size: 12px; }
  .panel .cchip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 2px 1px 4px; border-radius: 10px;
    border: 1px solid var(--divider-color); font-variant-numeric: tabular-nums; }
  .panel .cchip .swatch, .fp-picker .swatch { display: inline-block; width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--divider-color); }
  .panel .cchip button.link { font-size: 14px; line-height: 1; padding: 0 4px; }
  .fp-picker { position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column; background: var(--card-background-color, #fff);
    color: var(--primary-text-color); }
  .fp-pk-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--divider-color); font-size: 13px; }
  .fp-pk-title { flex: 1 1 160px; font-weight: 500; }
  .fp-pk-chips { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .fp-pk-bar button { font: inherit; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--divider-color); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); cursor: pointer; }
  .fp-pk-bar button.primary { background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .fp-pk-bar button.link { border: none; padding: 0 3px; background: none; }
  .fp-pk-bar .cchip { display: inline-flex; align-items: center; gap: 2px; padding: 1px 2px 1px 3px; border-radius: 10px; border: 1px solid var(--divider-color); }
  .fp-pk-view { position: relative; flex: 1; min-height: 0; overflow: hidden;
    background: repeating-conic-gradient(rgba(127,127,127,.18) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px; }
  .fp-pk-canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
  .fp-pk-loupe { position: absolute; display: none; pointer-events: none; border-radius: 8px; border: 2px solid var(--card-background-color, #fff);
    box-shadow: 0 2px 10px rgba(0,0,0,.45); image-rendering: pixelated; }
  .fp-pk-info { position: absolute; left: 8px; bottom: 8px; display: flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 8px; font-size: 12px;
    background: var(--card-background-color, #fff); box-shadow: 0 1px 4px rgba(0,0,0,.3); pointer-events: none; font-variant-numeric: tabular-nums; }
  .fp-pk-info:empty { display: none; }
  .panel .setup-flash { animation: fp-flash 1.5s ease-out; border-radius: 4px; }
  .panel details.mower-setup { border: 1px solid var(--divider-color); border-radius: 8px; padding: 6px 8px; margin: 4px 0 8px; }
  .panel details.mower-setup summary { cursor: pointer; font-weight: 500; }
  .panel details.mower-setup.complete summary { color: var(--success-color, #43a047); }
  .panel ul.setup { margin: 4px 0 0; }
  .panel ul.setup li { padding: 1px 0; }
  .panel ul.setup button.setup-row { color: var(--primary-text-color); text-align: left; font: inherit; cursor: pointer; }
  .panel ul.setup .mark { display: inline-block; width: 1.2em; font-weight: 700; }
  .panel ul.setup .ok .mark { color: var(--success-color, #43a047); }
  .panel ul.setup .todo .mark { color: var(--error-color, #db4437); }
  .panel ul.setup .opt .mark { color: var(--secondary-text-color); }
  @keyframes fp-flash { 0%, 40% { background: color-mix(in srgb, var(--primary-color, #03a9f4) 35%, transparent); } 100% { background: transparent; } }
  .panel ul.vtree li.part .state { color: var(--primary-color); }
  .panel ul.vtree button.expand { font-size: 12px; color: var(--secondary-text-color); padding: 0 4px; }
  .panel ul.vtree .yaml { font-size: 9.5px; padding: 0 4px; border-radius: 4px; letter-spacing: .04em;
    border: 1px solid var(--divider-color, rgba(0,0,0,.2)); color: var(--secondary-text-color); }
  .panel ul.vtree li.gone .name { text-decoration: line-through; opacity: .6; }
  .fp-pickmenu { position: absolute; z-index: 5; display: flex; flex-direction: column; gap: 2px; padding: 6px; min-width: 170px;
    box-sizing: border-box; border-radius: 8px; font-size: 12.5px; color: var(--primary-text-color);
    background: var(--card-background-color, #fff); border: 1px solid var(--divider-color, rgba(0,0,0,.12));
    box-shadow: 0 4px 16px rgba(0,0,0,.28); }
  .fp-pickmenu .title { padding: 2px 6px 4px; font-size: 11px; color: var(--secondary-text-color);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
  .fp-pickmenu button { font: inherit; text-align: left; padding: 6px 8px; border: none; border-radius: 5px; cursor: pointer;
    background: none; color: inherit; }
  .fp-pickmenu button:hover { background: color-mix(in srgb, var(--primary-color, #03a9f4) 14%, transparent); }
`;
