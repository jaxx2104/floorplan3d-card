// Badge DOM shared by markers and the object popup: logo (lazy <img>), status dot, battery chip.
import { brandUrl, integrationName } from './badges.ts';
import type { BadgeInfo, StatusKind } from './badges.ts';

/** An element carrying badges; remembers the last applied signature. */
export type BadgeHost = HTMLElement & { _fpBadgeSig?: string };

// platforms whose icon.png failed: never requested again (no broken image, no repeated 404s)
const failed = new Set<string>();
const darkFailed = new Set<string>();


// Shows the platform's logo as the box's first child (removed when none / failed). readable: title = integration name.
export function setLogo(box: Element, platform: string | null | undefined, dark: boolean, readable = false): void {
  let img = box.querySelector<HTMLImageElement>('img.fp-logo');
  if (!platform || failed.has(platform)) { if (img) img.remove(); return; }
  const useDark = dark && !darkFailed.has(platform);
  const src = brandUrl(platform, useDark);
  if (!img) {
    const el = document.createElement('img');
    img = el;
    img.className = 'fp-logo';
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      const p = el.dataset.platform ?? '';
      if (el.dataset.dark === '1') { darkFailed.add(p); el.dataset.dark = '0'; el.src = brandUrl(p, false); return; }
      failed.add(p);
      el.remove();
    });
    box.prepend(img);
  }
  if (img.dataset.platform === platform && img.dataset.dark === (useDark ? '1' : '0')) return;
  img.dataset.platform = platform;
  img.dataset.dark = useDark ? '1' : '0';
  img.title = readable ? integrationName(platform) : platform;
  img.src = src;
}

// The logo URL of a platform for a template (null: no platform, or its logo failed before).
export function logoSrc(platform: string | null | undefined, dark: boolean): string | null {
  if (!platform || failed.has(platform)) return null;
  return brandUrl(platform, dark && !darkFailed.has(platform));
}

// A template's logo (src from logoSrc) failed to load: a dark logo falls back to the light one, a light one is not asked for again.
export function logoFailed(platform: string, src: string): void {
  if (src === brandUrl(platform, true)) darkFailed.add(platform);
  else failed.add(platform);
}

function setPart(box: HTMLElement, cls: string, show: boolean, text?: string): HTMLElement | null {
  let el = box.querySelector<HTMLElement>('.' + cls);
  if (!show) { if (el) el.remove(); return null; }
  if (!el) { el = document.createElement('span'); el.className = cls; box.append(el); }
  if (text !== undefined && el.textContent !== text) el.textContent = text;
  return el;
}

const STATUS_TITLE: Record<StatusKind, string> = { green: 'On / has a value', grey: 'Off / idle', red: 'Unavailable', yellow: 'Low battery or a problem' };

// info: badgeInfo() result; host gets its badges (created on first use). Skips work when nothing changed.
export function applyBadges(host: BadgeHost, info: BadgeInfo | null | undefined, dark: boolean): void {
  const sig = info ? `${info.sig}|${dark ? 1 : 0}` : '';
  if (host._fpBadgeSig === sig) return;
  host._fpBadgeSig = sig;
  setLogo(host, info && info.platform, dark);
  const dot = setPart(host, 'fp-status', !!(info && info.status));
  if (dot && info && info.status) { dot.dataset.status = info.status; dot.title = STATUS_TITLE[info.status] || ''; }
  setPart(host, 'fp-batt', !!(info && info.battery !== null && info.battery !== undefined), info && info.battery !== null ? `${info.battery} %` : '');
}

export function resetBrandFailures(): void { failed.clear(); darkFailed.clear(); }
