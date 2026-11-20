/**
 * The scene as a PNG with a coordinate grid: format 3 of the interface test.
 * (The real viewer, milestone 4, draws in the browser; this is a still frame
 * for a model to look at.)
 */
import { createCanvas } from '@napi-rs/canvas';
import { UNITS_PER_TILE as T } from '../engine/constants';
import { TILE, tileAt } from '../engine/level';
import type { World } from '../engine/world';

export interface PngLabel {
  ch: string;
  tx: number;
  ty: number;
}

const PX = 28; // pixels per tile
const MARGIN = 30; // room for the coordinate numbers

export function renderPng(world: World, labels: readonly PngLabel[]): Buffer {
  const { level } = world;
  const w = level.width * PX + MARGIN;
  const h = level.height * PX + MARGIN;
  const canvas = createCanvas(w, h);
  const g = canvas.getContext('2d');
  // Tile (tx, ty) is drawn with its bottom-left corner at screen (sx(tx), sy(ty)); y grows up in the world, down on screen.
  const sx = (tilesX: number) => MARGIN + tilesX * PX;
  const sy = (tilesY: number) => level.height * PX - tilesY * PX;

  g.fillStyle = '#f4f1ea';
  g.fillRect(0, 0, w, h);
  for (let ty = 0; ty < level.height; ty++) {
    for (let tx = 0; tx < level.width; tx++) {
      const t = tileAt(level, tx, ty);
      if (t === TILE.SOLID) {
        g.fillStyle = '#3b3a45';
        g.fillRect(sx(tx), sy(ty + 1), PX, PX);
      } else if (t === TILE.ONEWAY) {
        g.fillStyle = '#8a6d3b';
        g.fillRect(sx(tx), sy(ty + 1), PX, 5);
      } else if (t === TILE.LADDER) {
        g.strokeStyle = '#8a6d3b';
        g.lineWidth = 2;
        g.strokeRect(sx(tx) + 6, sy(ty + 1), PX - 12, PX);
        for (let r = 1; r < 4; r++) {
          g.beginPath();
          g.moveTo(sx(tx) + 6, sy(ty + 1) + (r * PX) / 4);
          g.lineTo(sx(tx) + PX - 6, sy(ty + 1) + (r * PX) / 4);
          g.stroke();
        }
      }
    }
  }
  // Grid and coordinates.
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 1;
  g.fillStyle = '#222';
  g.font = '11px sans-serif';
  for (let tx = 0; tx <= level.width; tx++) {
    g.beginPath();
    g.moveTo(sx(tx) + 0.5, 0);
    g.lineTo(sx(tx) + 0.5, level.height * PX);
    g.stroke();
    if (tx < level.width) g.fillText(String(tx), sx(tx) + 6, level.height * PX + 18);
  }
  for (let ty = 0; ty <= level.height; ty++) {
    g.beginPath();
    g.moveTo(MARGIN, sy(ty) + 0.5);
    g.lineTo(w, sy(ty) + 0.5);
    g.stroke();
    if (ty < level.height) g.fillText(String(ty), 4, sy(ty) - 8);
  }
  // Things.
  for (const l of level.levers) {
    g.strokeStyle = '#7a1f1f';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(sx(l.tx) + PX / 2, sy(l.ty));
    g.lineTo(sx(l.tx) + PX / 2 + 7, sy(l.ty) - PX + 6);
    g.stroke();
  }
  for (const c of level.coins) {
    if (!world.coins.includes(c.id)) continue;
    g.fillStyle = '#e0b020';
    g.beginPath();
    g.arc(sx(c.tx) + PX / 2, sy(c.ty) - PX / 2, PX / 4, 0, Math.PI * 2);
    g.fill();
  }
  for (const e of level.exits) {
    g.fillStyle = '#3c9a4a';
    g.fillRect(sx(e.tx) + 3, sy(e.ty + 2), PX - 6, 2 * PX);
  }
  for (const bot of world.bots) {
    if (bot.exited) continue;
    const x = MARGIN + (bot.x / T) * PX;
    const y = level.height * PX - ((bot.y + bot.h) / T) * PX;
    g.fillStyle = bot.id === 'A' ? '#2f6fd6' : '#888888';
    g.fillRect(x, y, (bot.w / T) * PX, (bot.h / T) * PX);
    g.fillStyle = '#ffffff';
    g.font = 'bold 14px sans-serif';
    g.fillText(bot.id, x + 5, y + 18);
  }
  for (const l of labels) {
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#000000';
    g.lineWidth = 3;
    g.font = 'bold 16px sans-serif';
    g.strokeText(l.ch, sx(l.tx) + 9, sy(l.ty) - 8);
    g.fillText(l.ch, sx(l.tx) + 9, sy(l.ty) - 8);
  }
  return canvas.toBuffer('image/png');
}
