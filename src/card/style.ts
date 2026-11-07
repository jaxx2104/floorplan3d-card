// The card's shadow DOM styles (markers, popup, toolbar).
export const STYLE: string = `
  :host { display: block; }
  /* sections view (HA's layout = "grid"): fill the grid cell */
  :host([grid]), :host([grid]) ha-card, :host([grid]) .body { height: 100%; }
  :host([grid]) .body { box-sizing: border-box; }
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

  .fp-attach-label { font-size: 12px; padding: 2px 8px; border-radius: 10px; white-space: nowrap; pointer-events: none;
    transform: translateY(-22px); background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
  .fp-status { display: inline-block; width: 7px; height: 7px; border-radius: 50%; box-sizing: content-box;
    border: 1.5px solid var(--card-background-color, #fff); background: #9e9e9e; pointer-events: none; }
  .fp-status[data-status="green"] { background: #43a047; }
  .fp-status[data-status="grey"] { background: #9e9e9e; }
  .fp-status[data-status="red"] { background: #e53935; }
  .fp-status[data-status="yellow"] { background: #fbc02d; }
  .fp-pop-badges { display: inline-flex; align-items: center; gap: 4px; }
  .fp-pop-badges:empty { display: none; }
  .fp-pop-badges .fp-logo { width: 16px; height: 16px; object-fit: contain; }
  .fp-popup { position: absolute; left: 0; top: 0; z-index: 3; min-width: 220px; max-width: 300px; padding: 8px 10px 10px;
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
  .fp-pop-row.tile, .fp-pop-row.chain { min-height: 36px; }
  .fp-pop-row.ha { display: block; }
  .fp-pop-row.ha > * { --ha-card-box-shadow: none; --ha-card-border-width: 0; --ha-card-background: transparent; }
  .fp-pop-row.tile.ha + .fp-pop-row.ha { margin-top: 4px; }
  .fp-pop-name { border: none; background: none; padding: 0; font: inherit; text-align: left; cursor: pointer; }
  .fp-pop-row.tile .fp-pop-name { color: var(--primary-text-color); }
  .fp-switch { width: 36px; height: 20px; border-radius: 10px; border: none; padding: 2px; cursor: pointer; flex: none;
    background: var(--switch-unchecked-track-color, rgba(127,127,127,.45)); display: flex; transition: background .15s; }
  .fp-switch span { width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3);
    transition: transform .15s; }
  .fp-switch.on { background: var(--primary-color); }
  .fp-switch.on span { transform: translateX(16px); }
  .fp-pop-value { font-weight: 500; }
  .fp-pop-row.link { min-height: 26px; }
  .fp-pop-row:not(.link) + .fp-pop-row.link { border-top: 1px solid var(--divider-color, rgba(0,0,0,.12)); margin-top: 4px; padding-top: 4px; }
  .fp-pop-link { border: none; background: none; padding: 2px 0; font: inherit; color: var(--primary-color); cursor: pointer; }
  .fp-debug { position: absolute; left: 8px; bottom: 8px; z-index: 4; pointer-events: none; white-space: pre; font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--primary-text-color, #212121); background: color-mix(in srgb, var(--card-background-color, #fff) 82%, transparent);
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); border-radius: 6px; padding: 4px 6px; }
  .body { display: flex; }
  .body .stage { flex: 1; min-width: 0; }
  button.daynight[hidden] { display: none; }
  button.reset { font: inherit; line-height: 1; cursor: pointer; padding: 5px 8px; border-radius: 16px; display: flex;
    align-items: center; border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); --mdc-icon-size: 17px; }
  button.daynight { font: inherit; font-size: 15px; line-height: 1; cursor: pointer; padding: 5px 10px; border-radius: 16px;
    border: 1px solid var(--divider-color, rgba(0,0,0,.12)); background: var(--card-background-color, #fff);
    color: var(--primary-text-color); display: flex; align-items: center; --mdc-icon-size: 17px; }

  .stage.fp-hover canvas, .stage.fp-marker-hover canvas { cursor: pointer; }
`;
