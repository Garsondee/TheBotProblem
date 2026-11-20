/**
 * The room's moving parts: plates, doors, levers, the exit, coins, crates.
 *
 * Every switch animates between its states (a door slides, a plate sinks, a
 * lever tips) instead of snapping, because a change you can see happen is a
 * change you can follow. A door and whatever opens it share an accent colour.
 */
import type { CoinDef, DoorDef, ExitDef, LeverDef, PlateDef } from '../../../engine/level';
import { THEME } from '../palette';
import type { Ctx } from './draw';
import { alpha, roundRect } from './draw';

/** Tile coordinates (y up) to screen pixels (y down). */
export interface Space {
  X: (tilesX: number) => number;
  Y: (tilesY: number) => number;
  t: number;
}

export function drawPlate(ctx: Ctx, s: Space, p: PlateDef, pressed: number, accent: string): void {
  const { X, Y, t } = s;
  const x = X(p.tx) + t * 0.08;
  const w = p.width * t - t * 0.16;
  const floor = Y(p.ty);
  const h = t * (0.16 - 0.08 * pressed);
  ctx.fillStyle = THEME.metalDark;
  roundRect(ctx, x - t * 0.04, floor - t * 0.06, w + t * 0.08, t * 0.06, t * 0.03);
  ctx.fill();
  if (pressed > 0.02) {
    const glow = ctx.createRadialGradient(x + w / 2, floor, 0, x + w / 2, floor, w * 0.9);
    glow.addColorStop(0, alpha(accent, 0.35 * pressed));
    glow.addColorStop(1, alpha(accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(x - w * 0.5, floor - w, w * 2, w);
  }
  ctx.fillStyle = pressed > 0.5 ? accent : THEME.metal;
  roundRect(ctx, x, floor - h - t * 0.04, w, h, t * 0.05);
  ctx.fill();
  ctx.fillStyle = alpha(accent, 0.55 + 0.45 * pressed);
  ctx.fillRect(x + t * 0.1, floor - h - t * 0.04, w - t * 0.2, Math.max(1, t * 0.03));
}

export function drawDoor(ctx: Ctx, s: Space, d: DoorDef, open: number, accent: string): void {
  const { X, Y, t } = s;
  const x = X(d.tx);
  const top = Y(d.ty + d.height);
  const bottom = Y(d.ty);
  const h = bottom - top;
  // The frame stays; the panel slides up into the wall above.
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, top, t, h);
  ctx.clip();
  const panelY = top - open * h;
  const grad = ctx.createLinearGradient(x, 0, x + t, 0);
  grad.addColorStop(0, '#5b6788');
  grad.addColorStop(0.5, '#7684a8');
  grad.addColorStop(1, '#556183');
  ctx.fillStyle = grad;
  roundRect(ctx, x + t * 0.12, panelY, t * 0.76, h, t * 0.08);
  ctx.fill();
  ctx.fillStyle = 'rgba(20, 26, 48, 0.35)';
  for (let yy = panelY + t * 0.35; yy < panelY + h - t * 0.1; yy += t * 0.42) ctx.fillRect(x + t * 0.2, yy, t * 0.6, Math.max(1, t * 0.04));
  ctx.restore();
  // Rails on both sides, and the light that shows whether it's open.
  ctx.fillStyle = THEME.metalDark;
  ctx.fillRect(x + t * 0.04, top, t * 0.08, h);
  ctx.fillRect(x + t * 0.88, top, t * 0.08, h);
  const lightY = top + t * 0.18;
  ctx.fillStyle = open > 0.5 ? accent : alpha(accent, 0.25);
  ctx.beginPath();
  ctx.arc(x + t * 0.5, lightY - t * 0.32, t * 0.09, 0, Math.PI * 2);
  ctx.fill();
  if (open > 0.5) {
    ctx.fillStyle = alpha(accent, 0.25);
    ctx.beginPath();
    ctx.arc(x + t * 0.5, lightY - t * 0.32, t * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawLever(ctx: Ctx, s: Space, l: LeverDef, on: number, accent: string): void {
  const { X, Y, t } = s;
  const cx = X(l.tx) + t / 2;
  const floor = Y(l.ty);
  const pivotY = floor - t * 0.14;
  // Off leans left, on leans right.
  const angle = (-0.7 + 1.4 * on) as number;
  const len = t * 0.6;
  const kx = cx + Math.sin(angle) * len;
  const ky = pivotY - Math.cos(angle) * len;
  ctx.strokeStyle = THEME.metal;
  ctx.lineWidth = Math.max(2, t * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, pivotY);
  ctx.lineTo(kx, ky);
  ctx.stroke();
  if (on > 0.5) {
    ctx.fillStyle = alpha(accent, 0.25);
    ctx.beginPath();
    ctx.arc(kx, ky, t * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }
  // A filled knob flips and stays; a ring is a lever that must be held (for the spectator, who knows everything).
  ctx.fillStyle = on > 0.5 ? accent : alpha(accent, 0.55);
  ctx.strokeStyle = on > 0.5 ? accent : alpha(accent, 0.7);
  ctx.beginPath();
  ctx.arc(kx, ky, t * 0.11, 0, Math.PI * 2);
  if (l.mode === 'toggle') ctx.fill();
  else {
    ctx.lineWidth = Math.max(1.5, t * 0.06);
    ctx.stroke();
  }
  ctx.fillStyle = THEME.metalDark;
  roundRect(ctx, cx - t * 0.26, floor - t * 0.16, t * 0.52, t * 0.16, [t * 0.08, t * 0.08, 0, 0]);
  ctx.fill();
}

export function drawExit(ctx: Ctx, s: Space, e: ExitDef, placesLeft: number, time: number): void {
  const { X, Y, t } = s;
  const x = X(e.tx) + t * 0.08;
  const w = t * 0.84;
  const bottom = Y(e.ty);
  const top = Y(e.ty + 2) + t * 0.1;
  const h = bottom - top;
  const pulse = 0.85 + 0.15 * Math.sin(time * 2.2);
  const glow = ctx.createRadialGradient(x + w / 2, bottom - h * 0.45, 0, x + w / 2, bottom - h * 0.45, t * 1.6);
  glow.addColorStop(0, alpha(THEME.exit, 0.32 * pulse));
  glow.addColorStop(1, alpha(THEME.exit, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(x - t, top - t, w + 2 * t, h + 2 * t);
  const inside = ctx.createLinearGradient(0, top, 0, bottom);
  inside.addColorStop(0, alpha(THEME.exit, 0.85));
  inside.addColorStop(1, alpha('#dffcf2', 0.95));
  ctx.fillStyle = inside;
  roundRect(ctx, x, top, w, h, [w / 2, w / 2, t * 0.04, t * 0.04]);
  ctx.fill();
  ctx.strokeStyle = alpha('#ffffff', 0.7);
  ctx.lineWidth = Math.max(1, t * 0.05);
  ctx.stroke();
  // One small light per place left.
  const slots = e.slots;
  const gap = Math.min(t * 0.22, (t * 1.6) / Math.max(1, slots));
  const startX = x + w / 2 - ((slots - 1) * gap) / 2;
  for (let i = 0; i < slots; i++) {
    ctx.fillStyle = i < placesLeft ? THEME.exit : 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(startX + i * gap, top - t * 0.25, t * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawCoin(ctx: Ctx, s: Space, c: CoinDef, time: number, seed: number): void {
  const { X, Y, t } = s;
  const cx = X(c.tx) + t / 2;
  const cy = Y(c.ty) - t / 2 + Math.sin(time * 2 + seed * 6) * t * 0.06;
  const spin = 0.3 + 0.7 * Math.abs(Math.cos(time * 1.7 + seed * 9));
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, t * 0.55);
  glow.addColorStop(0, 'rgba(255, 210, 90, 0.35)');
  glow.addColorStop(1, 'rgba(255, 210, 90, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - t * 0.6, cy - t * 0.6, t * 1.2, t * 1.2);
  ctx.fillStyle = THEME.coinDark;
  ctx.beginPath();
  ctx.ellipse(cx, cy, t * 0.2 * spin, t * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = THEME.coin;
  ctx.beginPath();
  ctx.ellipse(cx, cy, t * 0.15 * spin, t * 0.15, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.beginPath();
  ctx.ellipse(cx - t * 0.05 * spin, cy - t * 0.06, t * 0.035 * spin, t * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** A crate at its body's position (x, y bottom-left, in tiles). Heavy crates look heavy: steel, not wood. */
export function drawCrate(ctx: Ctx, s: Space, xTiles: number, yTiles: number, heavy: boolean): void {
  const { X, Y, t } = s;
  const x = X(xTiles);
  const y = Y(yTiles + 1);
  const r = t * 0.1;
  ctx.fillStyle = THEME.shadow;
  ctx.beginPath();
  ctx.ellipse(x + t / 2, Y(yTiles), t * 0.48, t * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = heavy ? '#4f5d80' : THEME.woodDark;
  roundRect(ctx, x, y, t, t, r);
  ctx.fill();
  ctx.fillStyle = heavy ? '#6b7aa0' : THEME.wood;
  roundRect(ctx, x + t * 0.08, y + t * 0.08, t * 0.84, t * 0.84, r * 0.7);
  ctx.fill();
  if (heavy) {
    ctx.fillStyle = '#3e4a6a';
    for (const [dx, dy] of [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.2, 0.8],
      [0.8, 0.8],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x + t * dx, y + t * dy, t * 0.055, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillRect(x + t * 0.08, y + t * 0.46, t * 0.84, t * 0.08);
  } else {
    ctx.strokeStyle = THEME.woodDark;
    ctx.lineWidth = Math.max(1.5, t * 0.07);
    ctx.beginPath();
    ctx.moveTo(x + t * 0.16, y + t * 0.84);
    ctx.lineTo(x + t * 0.84, y + t * 0.16);
    ctx.stroke();
    ctx.fillStyle = THEME.woodLight;
    ctx.fillRect(x + t * 0.12, y + t * 0.1, t * 0.76, Math.max(1, t * 0.03));
  }
}
