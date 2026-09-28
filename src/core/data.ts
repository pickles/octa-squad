// Static game data: parts, tools, ammo, enemy archetypes. Pure data — no engine, no DOM.

export type ChassisKey = 'light' | 'assault' | 'heavy' | 'support';
export type WeaponKey = 'mg' | 'rifle' | 'sniper';
export type EquipKey = 'none' | 'radar' | 'plate' | 'booster' | 'stealth' | 'repair';
export type ToolKey = 'none' | 'missile' | 'chaff' | 'smoke' | 'flare' | 'decoy' | 'charge' | 'jammer' | 'probe' | 'mine';
export type AmmoType = 'std' | 'ap' | 'he';
export type MoveMode = 'normal' | 'fast' | 'careful';
export type Stance = 'hold' | 'free' | 'nofire';
export type Shape = 'tri' | 'sq' | 'hex' | 'circ' | 'truck' | 'turret' | 'radar' | 'hq' | 'site' | 'decoy' | 'probe';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface ChassisDef { name: string; hp: number; armor: number; speed: number; sensor: number; cost: number; shape: Shape; desc: string; repair?: number }
export interface WeaponDef { name: string; tag: 'MG' | 'RF' | 'SN'; range: number; dmg: number; cd: number; ps: number; cost: number; min?: number; desc: string }
export interface EquipDef { name: string; cost: number; desc: string; sensor?: number; emit?: number; hp?: number; armor?: number; speed?: number; stealth?: boolean; regen?: number }
export interface ToolDef {
  name: string; tag: string; ammo: number; cost: number; desc: string;
  range?: number; radius?: number; dur?: number; dmg?: number; splash?: number; cd?: number;
  target?: 'enemy' | 'struct' | 'point';
}

export const CHASSIS: Record<ChassisKey, ChassisDef> = {
  light:   { name: 'ライト',   hp: 70,  armor: 1, speed: 2.1,  sensor: 6.5, cost: 120, shape: 'tri',  desc: '足が速く視界が広い偵察役。打たれ弱いので前に出しすぎない' },
  assault: { name: 'アサルト', hp: 110, armor: 3, speed: 1.55, sensor: 5,   cost: 180, shape: 'sq',   desc: '速度・装甲・視界が平均的な主力。迷ったらこれ' },
  heavy:   { name: 'ヘヴィ',   hp: 180, armor: 6, speed: 1.0,  sensor: 4.5, cost: 260, shape: 'hex',  desc: 'とても硬いが遅い。先頭に立って敵の弾を受ける盾役' },
  support: { name: 'サポート', hp: 90,  armor: 2, speed: 1.45, sensor: 5.5, cost: 160, shape: 'circ', desc: '近く(2.5マス)の味方を毎秒3.5回復。本機は後方に置く', repair: 3.5 },
};

export const WEAPONS: Record<WeaponKey, WeaponDef> = {
  mg:     { name: 'マシンガン', tag: 'MG', range: 3.2, dmg: 6,  cd: 0.35, ps: 16, cost: 60,  desc: '射程は短いが連射。軽い機体（装甲1〜3）には最強だが、重装甲にはほぼ通らない。敵ミサイルを迎撃できる' },
  rifle:  { name: 'ライフル',   tag: 'RF', range: 4.8, dmg: 14, cd: 1.1,  ps: 20, cost: 90,  desc: '中距離で安定。どの装甲にもそこそこ通る標準武装。徹甲弾で重装型にも' },
  sniper: { name: '狙撃砲',     tag: 'SN', range: 8.5, dmg: 40, cd: 3.4,  ps: 36, cost: 150, min: 2, desc: '最長射程・一撃が重く重装甲も貫く。自分の視界より遠くは味方が見ていないと撃てない。2マス以内は撃てない' },
};

export const EQUIP: Record<EquipKey, EquipDef> = {
  none:    { name: 'なし', cost: 0, desc: '追加装備なし。予算を節約できる' },
  radar:   { name: 'レーダー', sensor: 2.5, emit: 2.5, cost: 60, desc: '視界 +2.5。ただし電波を出すので、敵からも2.5遠くで見つかり、誘導弾型に狙われる。戦闘中にZでON/OFFできる' },
  plate:   { name: '増加装甲', hp: 50, armor: 2, speed: -0.25, cost: 70, desc: 'HP +50・装甲 +2、ただし少し遅くなる。前衛向け' },
  booster: { name: 'ブースター', speed: 0.6, cost: 50, desc: '速度 +0.6。離脱・護衛や、マシンガン機が距離を詰めるのに' },
  stealth: { name: 'ステルス', stealth: true, cost: 90, desc: '敵に見つかる距離が半分になる（森ならさらに7割）。撃つと2.5秒間は効果が切れる' },
  repair:  { name: '自己修復', regen: 1.5, cost: 80, desc: '自分のHPを毎秒1.5回復し、部位損傷も20秒ごとに直す' },
};

export const TOOLS: Record<ToolKey, ToolDef> = {
  none:    { name: 'なし', tag: '', ammo: 0, cost: 0, desc: 'ツールなし' },
  missile: { name: 'ミサイル', tag: 'MSL', ammo: 4, range: 9, dmg: 45, splash: 1.2, cd: 3, cost: 120, target: 'enemy', desc: '射程9・威力45＋周囲に半分。ロックオンには目標が自分の視界内か、レーダー装備の味方の視界内にいる必要がある。チャフの中では誘導を失う。4発' },
  chaff:   { name: 'チャフ', tag: 'CHF', ammo: 2, range: 3.5, radius: 2.5, dur: 12, cd: 1, cost: 60, target: 'point', desc: '【守り】半径2.5に12秒。中を通るミサイルは誘導が切れ、中の機体はロックされない。代わりに中では味方のレーダーも効かない。2回' },
  smoke:   { name: '煙幕', tag: 'SMK', ammo: 2, range: 3.5, radius: 2.2, dur: 15, cd: 1, cost: 50, target: 'point', desc: '半径2.2に15秒。煙の中・煙越しの射撃は命中率35%。煙の中や煙の向こうの機体は目では見つかりにくい（×0.4）が、レーダーには映る。発砲炎も隠す。2回' },
  flare:   { name: '照明弾', tag: 'FLR', ammo: 2, range: 8, radius: 4, dur: 10, cd: 1, cost: 50, target: 'point', desc: '射程8、半径4を10秒照らして中の敵を視認できる。2回' },
  decoy:   { name: 'デコイ', tag: 'DCY', ammo: 1, range: 4, dur: 25, cd: 1, cost: 70, target: 'point', desc: '電波を出す囮を置く（HP60・25秒）。敵は本物と区別できず、優先して狙う。1回' },
  charge:  { name: '爆薬', tag: 'EXP', ammo: 2, range: 1.2, dmg: 260, cd: 1, cost: 70, target: 'struct', desc: '敵の建造物に隣接して仕掛ける（5秒後に爆発）。建造物に260、周囲の機体に100。2個' },
  jammer:  { name: '電障弾', tag: 'ECM', ammo: 2, range: 6, radius: 3, dur: 12, cd: 1, cost: 70, target: 'point', desc: '【攻め】射程6、半径3に12秒。中の敵は視界が4割に落ち、無線で助けを呼べず、レーダー塔も止まる。2回' },
  probe:   { name: 'プローブ', tag: 'PRB', ammo: 2, range: 5, dur: 60, cd: 1, cost: 50, target: 'point', desc: '小型センサーを置く（視界5・60秒・HP25）。見つかりにくいが、敵の偵察型には普通に見つかって壊される。2個' },
  mine:    { name: '地雷', tag: 'MIN', ammo: 3, range: 1.5, dmg: 60, splash: 1.2, cd: 1, cost: 60, target: 'point', desc: '足元近くに設置（1.5秒後に作動）。敵が踏むと威力60＋周囲に半分、踏んだ機体は脚部が壊れて遅くなる。敵からは見えない。3個' },
};

export const AMMO: Record<AmmoType, { name: string; tag: string; desc: string }> = {
  std: { name: '通常弾', tag: '通常', desc: '無制限' },
  ap:  { name: '徹甲弾', tag: '徹甲', desc: '装甲の効果を7割無視（威力0.9倍）。重装型に' },
  he:  { name: '榴弾',   tag: '榴弾', desc: '着弾点の周囲1にも半分。建造物に1.6倍、森の遮蔽を無視。装甲には弱い' },
};
export const AMMO_CAP: Record<WeaponKey, { ap: number; he: number }> = { mg: { ap: 40, he: 30 }, rifle: { ap: 12, he: 10 }, sniper: { ap: 5, he: 4 } };
export const MMODES: Record<MoveMode, { name: string }> = { normal: { name: '通常' }, fast: { name: '高速' }, careful: { name: '警戒' } };
export const STANCES: Record<Stance, string> = { hold: '待機射撃', free: '自由交戦', nofire: '射撃禁止' };
export const SYSN = { fcs: '火器管制', legs: '脚部', sensor: 'センサー' } as const;
export type SubsystemKey = keyof typeof SYSN;

export const DIFFS: Record<Difficulty, { name: string; dmg: number; hp: number }> = {
  easy: { name: 'やさしい', dmg: 0.55, hp: 0.8 }, normal: { name: 'ふつう', dmg: 0.8, hp: 1 }, hard: { name: 'むずかしい', dmg: 1, hp: 1.15 },
};

export const PILOTS: [string, string][] = [['ミナト', 'HERON'], ['カイ', 'MARLIN'], ['リン', 'WREN'], ['ソウマ', 'BISON'], ['アオイ', 'LARK'], ['ハヤト', 'SHRIKE'], ['ユキ', 'OWL'], ['レン', 'RAM']];

export interface Loadout { chassis: ChassisKey; weapon: WeaponKey; equip: EquipKey; tool: ToolKey }
export const DEFAULT_LOADOUT: Loadout[] = ([
  ['assault', 'rifle', 'plate', 'none'], ['assault', 'mg', 'booster', 'smoke'], ['light', 'rifle', 'radar', 'flare'], ['heavy', 'rifle', 'none', 'missile'],
  ['support', 'rifle', 'none', 'chaff'], ['light', 'mg', 'stealth', 'smoke'], ['light', 'sniper', 'radar', 'none'], ['heavy', 'mg', 'plate', 'mine'],
] as const).map(([chassis, weapon, equip, tool]) => ({ chassis, weapon, equip, tool }));

/** Normalise saved / legacy loadouts (old saves had missile as a weapon). */
export function migrateLoadout(x: any): Loadout {
  const o = { ...x };
  if (o.weapon === 'missile') { o.weapon = 'rifle'; o.tool = o.tool || 'missile'; }
  if (!(o.chassis in CHASSIS)) o.chassis = 'assault';
  if (!(o.weapon in WEAPONS)) o.weapon = 'rifle';
  if (!(o.equip in EQUIP)) o.equip = 'none';
  if (!(o.tool in TOOLS)) o.tool = 'none';
  return o as Loadout;
}

export interface UnitStats {
  hp: number; armor: number; speed: number; sensor: number; weapon: WeaponKey | null; stealth: boolean; regen: number; repair: number;
  cost: number; shape: Shape; emit: number; radarBonus: number; tool: ToolKey;
}
export function loadoutStats(c: Loadout): UnitStats {
  const ch = CHASSIS[c.chassis], w = WEAPONS[c.weapon], e = EQUIP[c.equip], tl = TOOLS[c.tool];
  return {
    hp: ch.hp + (e.hp || 0), armor: ch.armor + (e.armor || 0), speed: Math.max(0.5, +(ch.speed + (e.speed || 0)).toFixed(2)),
    sensor: ch.sensor + (e.sensor || 0), weapon: c.weapon, stealth: !!e.stealth, regen: e.regen || 0, repair: ch.repair || 0,
    cost: ch.cost + w.cost + e.cost + tl.cost, shape: ch.shape, emit: e.emit || 0, radarBonus: e.emit ? (e.sensor || 0) : 0, tool: c.tool,
  };
}

export type EType = 'scout' | 'trooper' | 'gunner' | 'heavy' | 'sniper' | 'launcher' | 'mortar' | 'turret' | 'radar' | 'hq' | 'site';
export interface ETypeDef { name: string; loadout?: Loadout; structure?: { hp: number; armor: number; sensor: number; weapon: WeaponKey | null; shape: Shape } }
export const ETYPES: Record<EType, ETypeDef> = {
  scout:   { name: '偵察型', loadout: { chassis: 'light', weapon: 'mg', equip: 'none', tool: 'mine' } },
  trooper: { name: '突撃型', loadout: { chassis: 'assault', weapon: 'rifle', equip: 'none', tool: 'none' } },
  gunner:  { name: '機銃型', loadout: { chassis: 'assault', weapon: 'mg', equip: 'none', tool: 'none' } },
  heavy:   { name: '重装型', loadout: { chassis: 'heavy', weapon: 'rifle', equip: 'none', tool: 'missile' } },
  sniper:  { name: '狙撃型', loadout: { chassis: 'light', weapon: 'sniper', equip: 'none', tool: 'none' } },
  launcher:{ name: '誘導弾型', loadout: { chassis: 'assault', weapon: 'mg', equip: 'none', tool: 'missile' } },
  mortar:  { name: '迫撃砲型', loadout: { chassis: 'assault', weapon: 'mg', equip: 'none', tool: 'none' } },
  turret:  { name: '砲台',       structure: { hp: 160, armor: 4, sensor: 6, weapon: 'rifle', shape: 'turret' } },
  radar:   { name: 'レーダー塔', structure: { hp: 110, armor: 2, sensor: 9, weapon: null, shape: 'radar' } },
  hq:      { name: '司令塔',     structure: { hp: 560, armor: 5, sensor: 5, weapon: 'mg', shape: 'hq' } },
  site:    { name: '敵野営地',   structure: { hp: 150, armor: 3, sensor: 3, weapon: null, shape: 'site' } },
};
