// Mission definitions. Each mission sets up enemies/zones on a Sim and decides win/lose.
import type { Sim, Outcome } from './sim';
import type { MapSpec } from './map';
import { rng } from './rng';

import type { Loadout } from './data';
import { TRAINING } from './training';

export type MissionId = string;
export type MissionType = '殲滅' | '強襲' | '索敵' | '護衛' | '離脱' | '教練';
/** A sub-goal shown on the result screen. Evaluated once when the mission ends (wins only). */
export interface Medal { name: string; desc: string; test(s: Sim): boolean }

export interface MissionDef extends MapSpec {
  id: MissionId; type: MissionType; code: string; name: string;
  budget: number; max: number; limit: number; arty: number;
  /** 1–3: training chapters, 4: operations. */
  part?: number;
  /** Fixed squad (training): replaces the hangar loadout. */
  squad?: Loadout[];
  medals?: Medal[];
  /** Multiplies enemy damage on top of the difficulty (training uses < 1). */
  dmgMul?: number;
  emines?: [number, number][];
  brief: string; win: string; lose: string; hint: string;
  setup(s: Sim): void;
  objective(s: Sim): string;
  /** Called every tick; may end the mission. */
  check(s: Sim): Outcome | undefined;
}

const ROAD4: [number, number][] = [[0.5, 20.5], [7.5, 18.5], [13.5, 12.5], [20.5, 10.5], [27.5, 6.5]];

const OPS: MissionDef[] = [
  {
    id: 'm1', type: '殲滅', code: 'OP-01', name: '灰原掃討戦', budget: 2600, max: 8, limit: 0, seed: 11, arty: 1,
    terr: { forest: 7, hills: 5, water: 1, rocks: 6 }, spawn: [4, 23], keys: [[15, 12], [22, 6], [20, 18], [9, 8]],
    brief: '平原に展開した敵部隊を撃滅する。守備隊は持ち場を離れないが、予備隊と巡回隊は無線で呼ばれれば駆けつける。北東の丘には誘導弾型（電波を出す機体を狙う）、中央には迫撃砲（密集を狙う）がいる。',
    win: '敵部隊の全滅', lose: '全機喪失',
    hint: '固まって動くと迫撃砲、レーダーを点けたままだと誘導弾に狙われる。予備隊を先に釣り出すか、迫撃砲を先に潰すと楽になる。',
    setup(s) {
      s.group(['trooper', 'trooper', 'gunner'], 15, 12, { role: 'garrison', leash: 6 });
      s.group(['launcher', 'heavy'], 22, 6, { role: 'overwatch' });
      s.group(['scout', 'scout', 'gunner'], 20, 18, { patrol: [[20, 18], [12, 21]] });
      s.group(['mortar'], 19, 9, { role: 'overwatch' });
      s.group(['trooper', 'scout'], 17, 8, { role: 'reserve' });
      s.group(['trooper', 'sniper'], 9, 8, { role: 'garrison', leash: 5 });
    },
    objective: s => `敵残存 ${s.countE()} 機`,
    check: s => s.countE() === 0 ? { win: true, reason: '敵部隊を全滅させた' } : undefined,
  },
  {
    id: 'm2', type: '強襲', code: 'OP-02', name: '第七レーダー基地', budget: 2400, max: 7, limit: 420, seed: 27, arty: 2,
    emines: [[13.5, 14.5], [14.5, 13.5], [15.5, 12.5], [16.5, 13.5], [12.5, 15.5], [17.5, 11.5], [18.5, 10.5], [19.5, 11.5]],
    terr: { forest: 8, hills: 4, water: 1, rocks: 7 }, spawn: [3, 24], keys: [[23, 5], [16, 11], [21, 7], [15, 15], [12, 8]],
    brief: '敵前線基地の司令塔を制限時間内に破壊する。基地の手前には地雷原がある（警戒移動で発見・処理できる）。レーダー塔は探知範囲が広く、見つかると守備隊が一斉に集まってくる。',
    win: '司令塔の破壊（7分以内）', lose: '全機喪失／時間切れ',
    hint: 'ステルス機と狙撃砲でまずレーダー塔を落とすと、守備隊を分断できる。',
    setup(s) {
      s.hq = s.spawnEnemy('hq', 23.5, 4.5, { objective: true });
      s.spawnEnemy('turret', 20.5, 5.5); s.spawnEnemy('turret', 23.5, 8.5); s.spawnEnemy('turret', 19.5, 8.5);
      s.radar = s.spawnEnemy('radar', 16.5, 11.5);
      s.group(['trooper', 'trooper'], 21, 7, { role: 'garrison', leash: 5 }); s.group(['heavy'], 24, 7, { role: 'garrison', leash: 4 });
      s.group(['gunner', 'gunner'], 15, 15, { patrol: [[15, 15], [12, 8]] });
      s.group(['sniper'], 19, 3, { role: 'overwatch' }); s.group(['launcher'], 18, 9, { role: 'overwatch' }); s.group(['mortar'], 22, 3, { role: 'overwatch' });
      s.group(['trooper', 'scout'], 20, 11, { role: 'reserve' });
    },
    objective: s => `司令塔 耐久 ${Math.max(0, Math.ceil(s.hq!.health!.hp / s.hq!.health!.maxHp * 100))}%　／　レーダー塔 ${s.radar!.life.alive ? '稼働中' : '破壊'}`,
    check: s => !s.hq!.life.alive ? { win: true, reason: '司令塔を破壊した' } : undefined,
  },
  {
    id: 'm3', type: '索敵', code: 'OP-03', name: '霧の森林帯', budget: 1400, max: 4, limit: 360, seed: 43, arty: 0,
    terr: { forest: 13, hills: 3, water: 1, rocks: 5 }, spawn: [4, 23], keys: [[7, 6], [20, 4], [23, 17], [14, 13]],
    brief: '森林地帯に潜む敵野営地4か所の位置を特定し、出撃地点に帰還する。敵を倒す必要はない。推定区域は実際の位置から少しずれている。',
    win: '4か所を2秒間視界に収め、1機以上がLZへ帰還', lose: '全機喪失／時間切れ',
    hint: '少数・高速・広視界。ステルスやレーダー装備の軽量機が向いている。交戦は避ける。',
    setup(s) {
      const S: [number, number, ('scout' | 'gunner' | 'trooper' | 'sniper' | 'heavy')[]][] = [
        [7.5, 6.5, ['scout', 'gunner']], [20.5, 4.5, ['trooper', 'sniper']], [23.5, 17.5, ['heavy', 'gunner']], [14.5, 13.5, ['trooper', 'trooper', 'scout']]];
      const R = rng(99);
      S.forEach(([x, y, g], i) => {
        s.sites.push(s.spawnEnemy('site', x, y, { label: 'ABCD'[i] }));
        s.group(g, x + 1.2, y + 1.2, { role: 'garrison', leash: 4 });
        s.addZone({ kind: 'hint', x: x + (R() - .5) * 3, y: y + (R() - .5) * 3, r: 3.3, label: '推定区域 ' + 'ABCD'[i] });
      });
      s.addZone({ kind: 'lz', x: 4, y: 23, r: 2.3, label: 'LZ' });
    },
    objective: s => { const n = s.sites.filter(x => x.structure!.scanned).length; return n < 4 ? `敵野営地の特定 ${n}/4` : '全拠点特定 ― LZへ帰還せよ' },
    check: s => s.sites.every(x => x.structure!.scanned) && s.livingSquad().some(u => s.inZone(u, 'lz')) ? { win: true, reason: '偵察情報を持ち帰った' } : undefined,
  },
  {
    id: 'm4', type: '護衛', code: 'OP-04', name: '補給路ルート12', budget: 2300, max: 7, limit: 0, seed: 58, arty: 1,
    emines: [[9.3, 17], [10.6, 15.6], [16, 11.8], [18.2, 11.1], [23.1, 9.1]],
    terr: { forest: 9, hills: 4, water: 1, rocks: 6 }, spawn: [3, 23], keys: ROAD4.concat([[10, 14], [17, 14], [19, 6], [25, 10], [14, 1.5]]), road: ROAD4,
    brief: '輸送車3両を道路沿いに東端まで送り届ける。道路には地雷が埋設されている（警戒移動の機体で先に処理する）。道路脇の森に待ち伏せがあり、途中で増援も来る。輸送隊は命令で停止・前進できる。',
    win: '輸送車2両以上が東端に到達', lose: '輸送車が2両未満になる／全機喪失',
    hint: '輸送隊を止めて先行偵察、待ち伏せと地雷を潰してから前進させるのが基本。修理機が有効。',
    setup(s) {
      const pts = ROAD4.slice(1).map(([x, y]) => ({ x, y }));
      ([[2.6, 20.2], [1.6, 20.4], [0.6, 20.6]] as const).forEach(([x, y], i) => s.spawnTruck('輸送車' + (i + 1), { x, y }, pts));
      s.group(['gunner', 'gunner'], 10, 14, { role: 'garrison', leash: 6 }); s.group(['trooper', 'heavy'], 17, 14, { role: 'garrison', leash: 6 }); s.group(['sniper', 'launcher'], 19, 6, { role: 'overwatch' }); s.group(['gunner', 'trooper', 'scout'], 25, 10, { role: 'reserve' });
      s.addZone({ kind: 'goal', x: 27, y: 6.5, r: 1.6, label: '到達点' });
      s.schedule(80, s2 => { s2.group(['trooper', 'trooper', 'gunner'], 14, 1.5, { hunt: true }); s2.log('増援：北から敵3機', 'warning') });
    },
    objective: s => `輸送車 到達 ${s.arrived}/3　健在 ${s.world.alive('truck').length}　（必要 2）`,
    check: s => {
      const alive = s.world.alive('truck').length;
      if (alive + s.arrived < 2) return { win: false, reason: '輸送車を失いすぎた' };
      if (alive === 0 && s.arrived >= 2) return { win: true, reason: '補給物資を届けた' };
    },
  },
  {
    id: 'm5', type: '離脱', code: 'OP-05', name: '包囲網突破', budget: 2200, max: 7, limit: 0, seed: 71, arty: 2,
    terr: { forest: 8, hills: 5, water: 2, rocks: 6 }, spawn: [6, 21], keys: [[24, 4], [4, 10], [18, 20], [18, 14], [15, 10], [22, 8], [26, 1], [27, 9]],
    brief: '敵の包囲下に取り残された。北東のLZに入ると回収機を要請でき、到着まで45秒かかる。到着の瞬間にLZ内にいた機体だけが回収される。敵は回収地点を知っており、最後はLZに押し寄せてくる。',
    win: '回収機到着時、LZ内に出撃数の6割以上（6機なら4機）', lose: '必要数を回収できない',
    hint: 'おとりで引き離しても、敵は見失うと最後に報告された位置かLZへ向かう。LZで45秒守り切れる火力と、到着を早めすぎない判断が要る。',
    setup(s) {
      s.group(['gunner', 'trooper'], 4, 10); s.group(['scout', 'trooper'], 18, 20, { patrol: [[18, 20], [18, 14]] });
      s.group(['sniper', 'trooper'], 15, 10); s.group(['gunner', 'gunner', 'heavy'], 22, 8, { role: 'reserve' });
      s.addZone({ kind: 'lz', x: 24, y: 4, r: 2.2, label: 'LZ' });
      s.need = Math.max(2, Math.ceil(s.squad.length * 0.6)); s.huntGoal = { x: 24, y: 4 };
      const P: [number, number][] = [[1, 27], [12, 27], [1, 10], [1, 18], [20, 27]];
      for (let k = 0; k < 7; k++) s.schedule(25 + k * 24, s2 => {
        if (s2.pickup) return;
        const p = P[k % P.length]; s2.group(k % 3 === 2 ? ['heavy', 'gunner', 'scout'] : ['trooper', 'gunner'], p[0], p[1], { hunt: true }); s2.log('敵増援接近', 'warning');
      });
    },
    objective: s => {
      const inLZ = s.livingSquad().filter(u => s.inZone(u, 'lz')).length;
      return s.pickup ? `回収機到着まで ${Math.max(0, Math.ceil(s.pickup - s.time))} 秒　LZ内 ${inLZ}/${s.need}　残存 ${s.countP()}` : `LZに入って回収機を要請せよ　残存 ${s.countP()} 機（必要 ${s.need}）`;
    },
    check: s => {
      if (!s.pickup && s.livingSquad().some(u => s.inZone(u, 'lz'))) {
        s.pickup = s.time + 45; s.log('回収機を要請。到着まで45秒、LZを確保せよ', 'info');
        s.group(['trooper', 'gunner', 'scout'], 26, 0.5, { hunt: true }); s.log('北方から敵部隊、LZへ接近中', 'warning');
        s.schedule(s.time + 18, s2 => { s2.group(['heavy', 'trooper'], 27, 9, { hunt: true }); s2.log('東から敵増援', 'warning') });
        s.schedule(s.time + 30, s2 => { s2.group(['gunner', 'gunner'], 18, 1, { hunt: true }); s2.log('北西から敵増援', 'warning') });
      }
      if (s.pickup && s.time >= s.pickup) {
        const inLZ = s.livingSquad().filter(u => s.inZone(u, 'lz'));
        s.extracted = inLZ.length; const left = s.countP() - inLZ.length;
        inLZ.forEach(u => { u.life.alive = false; u.life.gone = true });
        return s.extracted >= s.need
          ? { win: true, reason: `回収機が到着し ${s.extracted} 機を回収した${left ? `（${left} 機取り残し）` : ''}` }
          : { win: false, reason: `回収できたのは ${s.extracted} 機。必要数 ${s.need} に届かなかった` };
      }
      if (s.countP() < s.need) return { win: false, reason: '回収に必要な機数を割り込んだ' };
    },
  },
];

OPS.forEach(m => { m.part ??= 4 });
export const MISSIONS: MissionDef[] = [...TRAINING, ...OPS];
