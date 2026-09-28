// A small object-based ECS (in the style of miniplex): an entity is a plain object whose optional
// properties are its components. Systems ask the world for entities that carry a given set of
// components. Iteration order is always creation order, which keeps the simulation deterministic.

import type { AmmoType, EType, Loadout, MoveMode, Shape, Stance, ToolKey, WeaponDef, WeaponKey } from './data';

export interface Pt { x: number; y: number }
export type Team = 'P' | 'E';
export type Order = 'idle' | 'move' | 'attack' | 'tool' | 'hide';
export type AIState = 'guard' | 'patrol' | 'engage' | 'hunt' | 'return' | 'rally' | 'flank' | 'withdraw' | 'hold' | 'support' | 'search';

/** Enemy group roles: who answers a call for help, and how far they may leave their post. */
export type GroupRole = 'garrison' | 'patrol' | 'reserve' | 'overwatch' | 'hunt';
export type GroupState = 'idle' | 'rally' | 'attack' | 'withdraw' | 'hold' | 'search' | 'return';
/** An enemy fire team. Units share what they know and act as one (see systems/enemy.ts). */
export interface EGroup {
  id: number; role: GroupRole; post: Pt; leash: number; patrol: Pt[] | null; pi: number;
  state: GroupState; t: number;
  /** Group knowledge of our position (from sight, muzzle flashes, radio calls). */
  contact: Pt | null; contactT: number; seenN: number; seenT: number;
  rally: Pt | null; fallback: Pt | null; flankSide: number;
  lastHurt: number; lastFire: number; calledT: number; heardFrom: number | null;
  /** Waits hidden until you come close (or it gets hit). */
  ambush?: boolean;
  /** Doesn't answer radio calls (training). */
  deaf?: boolean;
}

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
  /** `cap`: group-move speed limit (the slowest member's speed), 0 = none. */
  mover?: { speed: number; path: Pt[]; repathT: number; stT: number; stP: Pt | null; cap: number };
  /** `off`: radar switched off (no range bonus, no emission). */
  sensor?: { range: number; radarBonus: number; emit: number; off?: boolean };
  weapon?: { key: WeaponKey; def: WeaponDef; cd: number; fireT: number; ammoType: AmmoType; nextAmmo: AmmoType | null; reloadT: number; ap: number; he: number };
  stealth?: { revealT: number };
  regen?: { rate: number };
  repairer?: { rate: number; radius: number };
  toolbelt?: { tool: ToolKey; ammo: number; cd: number; pending: ToolPending | null };
  /** Player-controllable squad member. */
  squad?: { no: number; pilot: string; cfg: Loadout; stance: Stance; order: Order; target: number | null; mmode: MoveMode; hidden: boolean; hideT: number };
  systems?: { fcs: boolean; legs: boolean; sensor: boolean; fixP: number };
  enemyAI?: { etype: EType; state: AIState; home: Pt; patrol: Pt[] | null; pi: number; lostT: number; lastKnown: Pt | null; alertLogged: boolean; target: number | null;
    gid: number; goal: Pt | null; goalAt: Pt | null; part: 'fix' | 'flank' | null; cd?: number;
    /** Lying in ambush: seen at 0.35× range until it fires or its team starts moving. */
    hidden?: boolean;
    /** Missile lock in progress (target id, seconds held). */
    lock?: { id: number; t: number };
    /** Damage taken per attacker (decays over ~8s). The biggest one is who this unit goes after. `pos` = where it was last seen. */
    aggro?: { id: number; v: number; pos: Pt | null }[] };
  structure?: { kind: EType; objective: boolean; label: string; scan: number; scanned: boolean; alerted: boolean };
  truck?: { hold: boolean };
  /** Decoys and probes: placed objects with a lifetime. */
  ephemeral?: { kind: 'decoy' | 'probe'; ttl: number };
  /** Muzzle flash: after firing, the unit that was shot at can see the shooter within its own weapon range + 1 until `until`. */
  muzzle?: { until: number; by: number };
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
