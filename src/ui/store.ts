// Browser persistence: hangar loadout and saved replays (localStorage, best-effort).
import { DEFAULT_LOADOUT, MISSIONS, loadoutStats, migrateLoadout } from '../core';
import type { Difficulty, Loadout, MissionDef, MissionId, Replay } from '../core';

export interface SaveData { diff: Difficulty; slots: Loadout[]; deploy: Partial<Record<MissionId, boolean[]>>; mission: MissionId }

export const SAVE: SaveData = { diff: 'easy', slots: DEFAULT_LOADOUT.map(x => ({ ...x })), deploy: {}, mission: 'm1' };
try {
  const s = JSON.parse(localStorage.getItem('octa-save') || 'null');
  if (s && Array.isArray(s.slots) && s.slots.length === 8) { Object.assign(SAVE, s); SAVE.slots = SAVE.slots.map(migrateLoadout) }
} catch { /* storage unavailable */ }

export function persist() { try { localStorage.setItem('octa-save', JSON.stringify(SAVE)) } catch { /* ignore */ } }
export function currentMission(): MissionDef { return MISSIONS.find(m => m.id === SAVE.mission) || MISSIONS[0] }
export function deployOf(m: MissionDef): boolean[] {
  if (!SAVE.deploy[m.id]) {
    let cost = 0, n = 0;
    SAVE.deploy[m.id] = SAVE.slots.map(s => { const c = loadoutStats(s).cost; if (n < m.max && cost + c <= m.budget) { cost += c; n++; return true } return false });
  }
  return SAVE.deploy[m.id]!;
}

const RKEY = 'octa-replays-v3';
export function loadReplays(): Replay[] { try { return JSON.parse(localStorage.getItem(RKEY) || '[]') } catch { return [] } }
export function saveReplay(rep: Replay) {
  const L = loadReplays(); L.unshift(rep); while (L.length > 15) L.pop();
  for (;;) { try { localStorage.setItem(RKEY, JSON.stringify(L)); break } catch { if (L.length <= 1) break; L.pop() } }
}
export function deleteReplay(i: number) { const L = loadReplays(); L.splice(i, 1); try { localStorage.setItem(RKEY, JSON.stringify(L)) } catch { /* ignore */ } }
export function isReplay(r: unknown): r is Replay {
  const x = r as Replay;
  return !!x && x.v === 3 && MISSIONS.some(m => m.id === x.mission) && Array.isArray(x.cmds) && Array.isArray(x.slots) && x.slots.length === 8;
}

/** Per-mission progress: cleared, and every sub-goal ever achieved. */
export interface Progress { clear: boolean; medals: boolean[] }
const PKEY = 'octa-progress';
export const PROGRESS: Record<string, Progress> = (() => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}') } catch { return {} } })();
export function recordResult(id: string, win: boolean, medals?: boolean[]) {
  if (!win) return;
  const p = PROGRESS[id] ??= { clear: false, medals: [] };
  p.clear = true; (medals || []).forEach((b, i) => { p.medals[i] = !!(p.medals[i] || b) });
  try { localStorage.setItem(PKEY, JSON.stringify(PROGRESS)) } catch { /* ignore */ }
}
