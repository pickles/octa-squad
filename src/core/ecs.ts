// A small object-based ECS (in the style of miniplex): an entity is a plain object whose optional
// properties are its components. Systems ask the world for entities that carry a given set of
// components. Iteration order is always creation order, which keeps the simulation deterministic.

import type { AmmoType, EType, Loadout, MoveMode, Shape, Stance, ToolKey, WeaponDef, WeaponKey } from './data';

export interface Pt { x: number; y: number }
export type Team = 'P' | 'E';
export type Order = 'idle' | 'move' | 'attack' | 'tool' | 'hide';
export type AIState = 'guard' | 'patrol' | 'engage' | 'hunt' | 'return';

export interface ToolPending { x: number; y: number; t: number | null }

/** All components. Every entity has the ones above the line; the rest are optional. */
export interface Entity {
  id: number;
  pos: Pt;
  team: Team;
  name: string;
  shape: Shape;
  life: { alive: boolean; gone: boolean };
  // ---- optional components ----
  health?: { hp: number; maxHp: number; armor: number; hitT: number };
  mover?: { speed: number; path: Pt[]; repathT: number; stT: number; stP: Pt | null };
  sensor?: { range: number; radarBonus: number; emit: number };
  weapon?: { key: WeaponKey; def: WeaponDef; cd: number; fireT: number; ammoType: AmmoType; nextAmmo: AmmoType | null; reloadT: number; ap: number; he: number };
  stealth?: { revealT: number };
  regen?: { rate: number };
  repairer?: { rate: number; radius: number };
  toolbelt?: { tool: ToolKey; ammo: number; cd: number; pending: ToolPending | null };
  /** Player-controllable squad member. */
  squad?: { no: number; pilot: string; cfg: Loadout; stance: Stance; order: Order; target: number | null; mmode: MoveMode; hidden: boolean; hideT: number };
  systems?: { fcs: boolean; legs: boolean; sensor: boolean; fixP: number };
  enemyAI?: { etype: EType; state: AIState; home: Pt; patrol: Pt[] | null; pi: number; lostT: number; lastKnown: Pt | null; alertLogged: boolean; target: number | null };
  structure?: { kind: EType; objective: boolean; label: string; scan: number; scanned: boolean; alerted: boolean };
  truck?: { hold: boolean };
  /** Decoys and probes: placed objects with a lifetime. */
  ephemeral?: { kind: 'decoy' | 'probe'; ttl: number };
  /** What the player knows about an enemy. */
  intel?: { lastSeen: Pt | null };
  /** How close a squad member is to being detected. */
  exposure?: { margin: number; warnBy: number | null };
}

export type With<K extends keyof Entity> = Entity & Required<Pick<Entity, K>>;

export class World {
  private list: Entity[] = [];
  private byId = new Map<number, Entity>();
  private nextId = 1;

  spawn<E extends Omit<Entity, 'id'>>(e: E): E & { id: number } {
    const ent = { ...e, id: this.nextId++ } as E & { id: number };
    this.list.push(ent as Entity);
    this.byId.set(ent.id, ent as Entity);
    return ent;
  }
  get(id: number | null | undefined): Entity | undefined { return id == null ? undefined : this.byId.get(id) }
  /** All entities (including dead ones — they stay so the HUD can show them). */
  all(): readonly Entity[] { return this.list }
  /** Entities that have every listed component. */
  with<K extends keyof Entity>(...keys: K[]): With<K>[] {
    const out: With<K>[] = [];
    for (const e of this.list) { let ok = true; for (const k of keys) if (e[k] === undefined) { ok = false; break } if (ok) out.push(e as With<K>) }
    return out;
  }
  /** Living entities that have every listed component. */
  alive<K extends keyof Entity>(...keys: K[]): With<K>[] { return this.with(...keys).filter(e => e.life.alive) }
}
