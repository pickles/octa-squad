// Isometric projection shared by the Phaser scene and the minimap.
import { N, T } from '../core';
import type { GameMap } from '../core';

export const TW = 64, TH = 32, HILL_H = 8, ROCK_H = 14;
export const OX = N * TW / 2 + 24, OY = 40, WPX = N * TW + 48, HPX = N * TH + 80;
export const TCOL: [number, number, number][] = [[74, 84, 68], [46, 72, 52], [108, 100, 78], [88, 90, 94], [38, 70, 92], [117, 104, 82]];

export const tileH = (t: number) => t === T.HILL ? HILL_H : t === T.ROCK ? ROCK_H : 0;
/** Tile coordinates -> world pixels (ground level). */
export const w2p = (x: number, y: number): [number, number] => [(x - y) * TW / 2 + OX, (x + y) * TH / 2 + OY];
/** World pixels (ground level) -> tile coordinates. */
export const p2w = (px: number, py: number) => { const a = (px - OX) / (TW / 2), b = (py - OY) / (TH / 2); return { x: (a + b) / 2, y: (b - a) / 2 } };
/** World pixel position of something standing at (x,y), raised by the terrain height. */
export const standPx = (map: GameMap, x: number, y: number): [number, number] => { const [px, py] = w2p(x, y); return [px, py - tileH(map.at(x, y))] };
export const shade = (c: [number, number, number], f: number, j = 0) =>
  ((Math.max(0, Math.min(255, c[0] * f + j)) | 0) << 16) | ((Math.max(0, Math.min(255, c[1] * f + j)) | 0) << 8) | (Math.max(0, Math.min(255, c[2] * f + j)) | 0);
export const css = (n: number) => '#' + n.toString(16).padStart(6, '0');
