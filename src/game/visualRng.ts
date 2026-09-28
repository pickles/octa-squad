// Cosmetic randomness for rendering (tree jitter etc.). Kept separate from the simulation RNG so that
// drawing can never affect the deterministic battle.
import { rng } from '../core/rng';
export const mulberryVisual = (seed: number) => rng(seed ^ 0x5bd1e995);
