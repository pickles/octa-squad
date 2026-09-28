# オクタ小隊戦記（OCTA SQUAD）

工画堂スタジオ『ブルーフロウ』やパワードールに影響を受けた、クォータビューのリアルタイム戦術ゲーム。
最大8機の小隊を作戦ごとに編成し、索敵・隠蔽・弾種・ツールを使い分けて任務を達成する。

- **描画・入力**：Phaser 3（WebGL / Canvas）
- **ゲームロジック**：エンジンに依存しない TypeScript の ECS コア（`src/core`）。ブラウザでも Node でも同じコードが動く
- **決定論的シミュレーション**：固定 30 tick/秒 ＋ シード付き乱数。命令だけを記録したリプレイで完全に再現できる
- **AI 用インターフェース**：ブラウザでは `window.octa`、Node では `AgentPort` を直接使う

## 開発

```
npm install
npm run dev            # http://localhost:5173
npm test               # vitest（決定性・マップ到達性・AI API）
npm run typecheck
npm run build          # dist/（通常のビルド）
npm run build:single   # dist-single/index.html（全部入りの1ファイル。claude.ai の Artifact 用）
npm run agent -- m2 normal 5   # Node だけで内蔵AIに1戦させる（ブラウザ不要・1戦0.5秒程度）
```

## ディレクトリ構成

```
src/
  core/                  エンジン非依存（DOM も Phaser も使わない）
    ecs.ts               World と Entity（オブジェクト型 ECS）、コンポーネント定義
    data.ts              機体・武装・装備・ツール・弾種・敵タイプ
    map.ts               地形、マップ生成、A* 経路探索
    missions.ts          5作戦の配置・勝敗条件
    sim.ts               Sim：ワールドと戦場状態を持ち、step() で1tick進める
    systems/             vision / units(status, squad, enemy, movement) / combat / fields / index(実行順)
    commands.ts          命令の型・実行・記録（リプレイの単位）
    agent.ts             AgentPort：霧を守った観測・テキスト化・命令の検証、rules
    brain.ts             内蔵AI指揮官（AgentPort だけを使う参照実装）
  game/
    controller.ts        BattleSession：選択・照準・一時停止・倍速・AI交代など UI 側の状態
    BattleScene.ts       Phaser シーン：アイソメ描画、霧、エフェクト、マウス入力
    iso.ts               座標変換（タイル ⇔ ワールドピクセル）
  ui/                    DOM：格納庫、HUD、保存（localStorage）、CSS
  api/octa.ts            window.octa
  main.ts                画面切替・キー入力・Phaser 起動
tools/agent-headless.ts  Node で AI に戦わせるサンプル（decide() を差し替える）
tests/core.test.ts
legacy/                  移植前の単一 HTML 版
```

### ECS の考え方

エンティティは「コンポーネントをプロパティとして持つただのオブジェクト」。システムは必要なコンポーネントを持つものだけを問い合わせて処理する。

```ts
for (const u of sim.world.alive('weapon')) { ... }          // 武装を持つ生存エンティティ
for (const u of sim.world.alive('squad', 'mover')) { ... }  // 自小隊で移動できるもの
```

| コンポーネント | 持つもの |
|---|---|
| `pos` `team` `name` `shape` `life` | 全エンティティ |
| `health` | HP・装甲を持つもの |
| `mover` | 移動できるもの（経路・速度） |
| `sensor` | 視界・レーダー・電波 |
| `weapon` | 武装・弾種・装填 |
| `toolbelt` | ツールと残弾・使用予約 |
| `squad` | プレイヤーの小隊機（番号・姿勢・命令・移動モード・隠蔽） |
| `enemyAI` | 敵の行動状態（警戒・巡回・交戦・追跡・帰投） |
| `structure` | 建造物（砲台・レーダー塔・司令塔・野営地） |
| `stealth` `regen` `repairer` `systems` `truck` `ephemeral` `intel` `exposure` | それぞれの機能 |

新しい性質は「コンポーネントを1つ足して、それを扱うシステムを1つ足す」で追加できる。
システムの実行順は `src/core/systems/index.ts` に固定してある（決定性のため）。

### 決定性のルール

- シミュレーション内の乱数は必ず `sim.rnd()`。描画側の見た目用乱数は `game/visualRng.ts`
- 外部からの変更は必ず `sim.issue(command)` を通す（記録される）
- エフェクトは `sim.emit()` でキューに積むだけ。描画側が取り出して表示する

## AI から操作する

### Node（推奨・高速）

```ts
import { Sim, AgentPort, brainTick, buildLoadout, DEFAULT_LOADOUT, rulesText } from './src/core';
const { slots, deploy } = buildLoadout('m1', DEFAULT_LOADOUT, [{ slot: 1, chassis: 'heavy', weapon: 'rifle', equip: 'plate', tool: 'missile' }]);
const sim = new Sim({ mission: 'm1', difficulty: 'normal', seed: 1, slots, deploy });
const port = new AgentPort(sim);
while (!sim.over) { port.act([{ cmd: 'move', units: 'all', x: 12, y: 9 }]); sim.run(1); console.log(port.text()) }
```

### ブラウザ（`window.octa`）

```js
octa.rules()                                  // ルール（LLM のシステムプロンプト向け）
octa.start({mission:'m1', difficulty:'normal', seed:1, loadout:[...], auto:false})
octa.observe() / octa.text() / octa.map()
octa.act([{cmd:'attack', units:'all', target:'e17'}, {cmd:'tool', units:[1], target:'e17'}])
octa.step(1.0)                                // 時間はここでしか進まない（realtime:true で実時間）
octa.auto(true)                               // 内蔵AIに指揮させる
octa.replay() / octa.playReplay(json) / octa.verifyReplay(json)
```

## 操作

| 操作 | 内容 |
|---|---|
| 左クリック / ドラッグ | 選択 / 範囲選択（`Shift` で追加） |
| 選択中に地面・敵をクリック | 移動 / 攻撃（右クリックでも可） |
| `WASD`・矢印・右ドラッグ / ホイール | スクロール / ズーム |
| `1`〜`8` / `E` | 機体選択 / 全機 |
| `Space` / `F` | 一時停止 / 倍速 |
| `X` `Q` `M` `H` `R` | 停止 / 姿勢 / 移動モード / 隠蔽 / 弾種 |
| `T` / `B` | ツール / 砲撃支援（`Esc` で取消） |
| `V` / `C` / `G` | 警戒圏表示 / 選択機へ / AI指揮 |
