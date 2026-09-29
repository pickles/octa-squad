// Danger alerts: a banner in the middle of the battlefield and a short synthesized sound.
// Sounds are generated with WebAudio (no files); the mute state is remembered per browser.
import type { Alert } from '../core';

let ctx: AudioContext | null = null;
let muted = (() => { try { return localStorage.getItem('octa-mute') === '1' } catch { return false } })();
export const isMuted = () => muted;
export function setMuted(m: boolean) { muted = m; try { localStorage.setItem('octa-mute', m ? '1' : '0') } catch { /* ignore */ } }

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'square', to?: number, vol = 0.07) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + start;
  o.type = type; o.frequency.setValueAtTime(freq, t0); if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.01); g.gain.setValueAtTime(vol, t0 + dur - 0.03); g.gain.linearRampToValueAtTime(0, t0 + dur);
  o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + dur + 0.02);
}

export function playAlert(kind: Alert['kind']) {
  if (muted) return;
  try { ctx ??= new AudioContext(); if (ctx.state === 'suspended') void ctx.resume() } catch { return }
  if (kind === 'lock') { tone(880, 0, 0.09); tone(880, 0.14, 0.09) }                                  // two beeps
  else if (kind === 'missile') { for (let i = 0; i < 4; i++) tone(1320, i * 0.09, 0.06) }               // rapid chirps
  else { tone(1400, 0, 0.9, 'sine', 380, 0.09) }                                                         // falling whistle
}

/** Unlock audio on the first user gesture (browsers block sound until then). */
export function primeAudio() { try { ctx ??= new AudioContext(); if (ctx.state === 'suspended') void ctx.resume() } catch { /* ignore */ } }
