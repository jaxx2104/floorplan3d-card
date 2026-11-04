// The Views tab pick menu: a click on the model highlights a part and offers hide / show / reveal.

import { setRuleState, pickSelector } from '../../views.ts';
import { layoutRules, setRule, treeRows, nodePos } from '../tabs/views.ts';
import { esc } from '../html.ts';
import type { EditMode } from '../../edit-mode.ts';

// Click on the model (Views tab): highlight the part and offer hide/show.
export function pickView(ed: EditMode, e: PointerEvent) {
  const idx = ed.card.viewIndex();
  const owner = idx ? ed.view.pickModel(e.clientX, e.clientY) : null;
  const p = idx && owner && owner.hit ? pickSelector(idx, nodePos(ed, idx, owner.hit.object), owner.kind === 'untagged' ? null : owner) : null;
  closeMenu(ed);
  if (!p) {
    ed.vwPick = null;
    ed.view.highlightModelNode(null);
    ed.message = { text: 'Click on a part of the model', warn: true };
    ed.render();
    return;
  }
  ed.vwPick = { sel: p.sel, idx: p.idx };
  ed.message = null;
  ed.view.highlightModelNode(idx!.nodes[p.idx].node); // p needs idx
  const tree = treeRows(ed);
  const r = tree && [...tree.tree, ...tree.layers, ...tree.groups].find((x) => x.sel === p.sel);
  openMenu(ed, e, r ? r.label : idx!.nodes[p.idx].name || p.sel);
  ed.render();
}

export function openMenu(ed: EditMode, e: PointerEvent, title: string) {
  const stage = ed.card._stage;
  const m = document.createElement('div');
  m.className = 'fp-pickmenu';
  const pick = ed.vwPick!; // set by pickView just before
  m.innerHTML = `<div class="title" title="${esc(pick.sel)}">${esc(title)}</div>
      <button data-act="vw-hide-here">Hide in this view</button>
      ${/^(object|type|group|tag):/.test(pick.sel) ? '' : '<button data-act="vw-hide-keep" title="Hide its surfaces; lamps and other model objects inside stay visible and tappable">Hide surfaces, keep devices</button>'}
      <button data-act="vw-show-here">Show in this view</button>
      <button data-act="vw-hide-all">Hide in all views</button>
      <button data-act="vw-reveal">Reveal in tree</button>`;
  m.addEventListener('click', (ev) => onMenuClick(ed, ev));
  stage.append(m);
  const r = stage.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  const x = Math.max(4, Math.min(e.clientX - r.left + 8, r.width - w - 4));
  const y = Math.max(4, Math.min(e.clientY - r.top + 8, r.height - h - 4));
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  ed.menu = m;
  window.addEventListener('pointerdown', ed._onMenuAway, true);
}

export function closeMenu(ed: EditMode) {
  if (!ed.menu) return;
  window.removeEventListener('pointerdown', ed._onMenuAway, true);
  ed.menu.remove();
  ed.menu = null;
}

export function onMenuClick(ed: EditMode, e: MouseEvent) {
  const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
  const pick = ed.vwPick;
  if (!btn || !pick) return;
  const cur = ed.card.currentView();
  closeMenu(ed);
  switch (btn.dataset.act) {
    case 'vw-hide-here':
    case 'vw-hide-keep':
    case 'vw-show-here':
      if (!cur) return;
      ed.vwPick = null;
      ed.view.highlightModelNode(null);
      setRule(ed, cur.id, pick.sel, btn.dataset.act === 'vw-show-here' ? 'shown' : 'hidden', { keepObjects: btn.dataset.act === 'vw-hide-keep' });
      return;
    case 'vw-hide-all': {
      const views = { ...ed.layout.views };
      for (const v of ed.card._views || []) {
        if (v.hidden) continue;
        views[v.id] = { ...views[v.id], rules: setRuleState(layoutRules(ed, v.id), pick.sel, 'hidden') };
      }
      ed.vwPick = null;
      ed.view.highlightModelNode(null);
      ed.commit({ ...ed.layout, views });
      return;
    }
    case 'vw-reveal': reveal(ed, pick); return;
    default:
  }
}

// Scroll the tree row of a picked part (or of its nearest listed ancestor) into view and flash it.
export function reveal(ed: EditMode, pick: { sel: string; idx: number }) {
  ed.tab = 'views';
  const tree = treeRows(ed);
  const r = tree && tree.tree.find((x) => x.sel === pick.sel);
  if (r && r.parent && !r.parent.startsWith('level:')) ed.vwExpanded.add(r.parent);
  ed.render();
  const idx = ed.card.viewIndex();
  let sel = pick.sel;
  const rows = () => [...ed.panel.querySelectorAll<HTMLElement>('ul.vtree li[data-sel]')];
  if (!rows().some((li) => li.dataset.sel === sel) && tree && idx) {
    const shown = new Set(rows().map((li) => li.dataset.sel));
    for (let p = pick.idx; p >= 0; p = idx.nodes[p].parent) {
      const row = tree.rowOf.get(p);
      if (row !== undefined && shown.has(row)) { sel = row; break; }
    }

  }
  const li = rows().find((x) => x.dataset.sel === sel);
  if (!li) return;
  li.scrollIntoView({ block: 'nearest' });
  li.classList.remove('flash');
  void li.offsetWidth; // restart the animation
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 1300);
}
