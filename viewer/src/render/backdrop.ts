/**
 * The backdrop and the terrain: drawn once per room and size, then reused
 * every frame as images (they never change while a room plays).
 *
 * The look: a quiet dusk sky with a low moon and two far hills, and solid
 * ground as dark silhouettes whose top edges catch the moonlight. Convex
 * corners are rounded; that one detail does most of the work of making
 * blocky tiles read as soft, designed shapes.
 */
import type { Level } from '../../../engine/level';
import { isLadderTop, TILE, tileAt } from '../../../engine/level';
import { THEME } from '../palette';
import type { Ctx } from './draw';
import { hashOf, mix, roundRect } from './draw';

export interface Frame {
  /** CSS pixels per tile. */
  tile: number;
  /** The level's rectangle on the canvas, CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

function offscreen(w: number, h: number, dpr: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d') as Ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx };
}

/** The sky behind everything, for the whole canvas. */
export function renderSky(cssW: number, cssH: number, f: Frame, dpr: number): HTMLCanvasElement {
  const { canvas, ctx } = offscreen(cssW, cssH, dpr);
  const sky = ctx.createLinearGradient(0, 0, 0, cssH);
  sky.addColorStop(0, THEME.skyTop);
  sky.addColorStop(1, THEME.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, cssW, cssH);
  const warm = ctx.createLinearGradient(0, f.y + f.h * 0.45, 0, f.y + f.h);
  warm.addColorStop(0, 'rgba(255, 176, 128, 0)');
  warm.addColorStop(1, THEME.horizon);
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, cssW, cssH);

  // A low moon, mostly glow.
  const mx = f.x + f.w * 0.8;
  const my = f.y + f.h * 0.24;
  const glow = ctx.createRadialGradient(mx, my, 0, mx, my, f.h * 0.55);
  glow.addColorStop(0, 'rgba(255, 236, 200, 0.22)');
  glow.addColorStop(0.35, 'rgba(255, 220, 180, 0.07)');
  glow.addColorStop(1, 'rgba(255, 220, 180, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.fillStyle = THEME.moon;
  ctx.beginPath();
  ctx.arc(mx, my, f.tile * 0.9, 0, Math.PI * 2);
  ctx.fill();

  // Two far hills, low and soft, for depth.
  const hill = (base: number, amp: number, seed: number, colour: string) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, cssH);
    for (let x = 0; x <= cssW; x += 8) {
      const u = x / cssW;
      const y = f.y + f.h * base - amp * f.h * (0.55 * Math.sin(u * 5.1 + seed) + 0.3 * Math.sin(u * 11.7 + seed * 2.3) + 0.15 * Math.sin(u * 23 + seed));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(cssW, cssH);
    ctx.closePath();
    ctx.fill();
  };
  hill(0.6, 0.07, 1.3, THEME.hillFar);
  hill(0.72, 0.05, 4.1, THEME.hillNear);
  return canvas;
}

/** Stars: fixed places, gently twinkling. Drawn live. */
export function drawStars(ctx: Ctx, f: Frame, time: number): void {
  for (let i = 0; i < 70; i++) {
    const hx = hashOf(`sx${i}`);
    const hy = hashOf(`sy${i}`);
    const x = f.x + hx * f.w;
    const y = f.y + hy * hy * f.h * 0.62;
    const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * (0.6 + hashOf(`st${i}`) * 1.4) + i));
    ctx.fillStyle = `rgba(220, 230, 255, ${0.12 + 0.45 * tw * (1 - hy * 0.7)})`;
    const r = 0.6 + hashOf(`sr${i}`) * 0.9;
    ctx.fillRect(x - r / 2, y - r / 2, r, r);
  }
}

/** The terrain: solid ground, one-way platforms and ladders, at the level's rectangle size. */
export function renderTerrain(level: Level, f: Frame, dpr: number): HTMLCanvasElement {
  const { canvas, ctx } = offscreen(f.w, f.h, dpr);
  const t = f.tile;
  const H = level.height;
  const solid = (tx: number, ty: number) => tileAt(level, tx, ty) === TILE.SOLID;
  // Screen rectangle of a tile (y grows down on screen, up in the level).
  const px = (tx: number) => tx * t;
  const py = (ty: number) => (H - 1 - ty) * t;
  const r = t * 0.22;
  const seam = 0.6; // overlap shared edges a little, so no hairline gaps show between tiles

  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      if (!solid(tx, ty)) continue;
      const up = solid(tx, ty + 1);
      const down = solid(tx, ty - 1);
      const left = solid(tx - 1, ty);
      const right = solid(tx + 1, ty);
      const x = px(tx) - (left ? seam : 0);
      const y = py(ty) - (up ? seam : 0);
      const w = t + (left ? seam : 0) + (right ? seam : 0);
      const h = t + (up ? seam : 0) + (down ? seam : 0);
      // Higher ground is a touch lighter, as if nearer the moon.
      ctx.fillStyle = mix(THEME.terrainBottom, THEME.terrainTop, Math.min(1, (ty + 1) / H + 0.15));
      roundRect(ctx, x, y, w, h, [!up && !left ? r : 0, !up && !right ? r : 0, !down && !right ? r * 0.6 : 0, !down && !left ? r * 0.6 : 0]);
      ctx.fill();
      // Faces open to the air: a soft side light and a dark underside.
      if (!left || !right) {
        ctx.fillStyle = 'rgba(120, 145, 200, 0.10)';
        if (!left) ctx.fillRect(px(tx), py(ty) + (up ? 0 : r), t * 0.06, t - (up ? 0 : r));
        if (!right) ctx.fillRect(px(tx) + t * 0.94, py(ty) + (up ? 0 : r), t * 0.06, t - (up ? 0 : r));
      }
      if (!down) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
        ctx.fillRect(px(tx) + (left ? 0 : r * 0.6), py(ty) + t * 0.9, t - (left ? 0 : r * 0.6) - (right ? 0 : r * 0.6), t * 0.1);
      }
    }
  }
  // The moonlit lip on every top face, drawn after the bodies so it sits on top of the seams.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      if (!solid(tx, ty) || solid(tx, ty + 1)) continue;
      const left = solid(tx - 1, ty) && !solid(tx - 1, ty + 1);
      const right = solid(tx + 1, ty) && !solid(tx + 1, ty + 1);
      const x = px(tx) - (left ? seam : 0);
      const w = t + (left ? seam : 0) + (right ? seam : 0);
      ctx.fillStyle = THEME.lip;
      roundRect(ctx, x, py(ty), w, t * 0.13, [left ? 0 : r, right ? 0 : r, 0, 0]);
      ctx.fill();
      ctx.fillStyle = THEME.lipHighlight;
      ctx.globalAlpha = 0.75;
      roundRect(ctx, x + (left ? 0 : r * 0.5), py(ty), w - (left ? 0 : r * 0.5) - (right ? 0 : r * 0.5), Math.max(1, t * 0.035), 0);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // One-way platforms: wooden planks with a small gap between boards.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      if (tileAt(level, tx, ty) !== TILE.ONEWAY) continue;
      const x = px(tx) + t * 0.03;
      const y = py(ty);
      ctx.fillStyle = THEME.woodDark;
      roundRect(ctx, x, y + t * 0.04, t * 0.94, t * 0.22, t * 0.06);
      ctx.fill();
      ctx.fillStyle = THEME.wood;
      roundRect(ctx, x, y, t * 0.94, t * 0.18, t * 0.06);
      ctx.fill();
      ctx.fillStyle = THEME.woodLight;
      ctx.fillRect(x + t * 0.06, y + t * 0.02, t * 0.82, Math.max(1, t * 0.03));
    }
  }

  // Ladders: two rails and rungs.
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      if (tileAt(level, tx, ty) !== TILE.LADDER) continue;
      const x = px(tx);
      const y = py(ty);
      const top = isLadderTop(level, tx, ty);
      ctx.fillStyle = THEME.woodDark;
      ctx.fillRect(x + t * 0.16, y + (top ? t * 0.02 : 0), t * 0.09, t - (top ? t * 0.02 : 0));
      ctx.fillRect(x + t * 0.75, y + (top ? t * 0.02 : 0), t * 0.09, t - (top ? t * 0.02 : 0));
      ctx.fillStyle = THEME.wood;
      for (let i = 0; i < 4; i++) {
        roundRect(ctx, x + t * 0.18, y + t * (0.12 + i * 0.25), t * 0.64, t * 0.07, t * 0.03);
        ctx.fill();
      }
      if (top) {
        ctx.fillStyle = THEME.woodLight;
        roundRect(ctx, x + t * 0.12, y, t * 0.76, t * 0.06, t * 0.03);
        ctx.fill();
      }
    }
  }
  return canvas;
}
