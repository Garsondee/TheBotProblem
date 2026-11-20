/**
 * Drawing a bot.
 *
 * A bot is a rounded body in its own colour with a dark face screen, two
 * glowing eyes that look where it is heading, its letter on its chest and its
 * own antenna shape. Motion gives it life without clutter: a lean when it
 * walks, a stretch when it jumps, a squash when it lands, eyes that squint
 * when it pushes and widen when it falls, and a blink now and then.
 */
import { eyeGlow } from '../palette';
import type { BotLook } from '../palette';
import type { Ctx } from './draw';
import { alpha, clamp, hashOf, roundRect } from './draw';
import type { Space } from './things';

export interface BotPose {
  id: string;
  look: BotLook;
  /** Body box in tiles: left edge, feet height, width, height. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Speed in tiles per second. */
  vx: number;
  vy: number;
  anim: string;
  facing: 1 | -1;
  /** 0 to 1: how freshly it landed. */
  squash: number;
  /** 0 to 1: fully there, or faded out (gone through the exit). */
  opacity: number;
  /** 0 to 1: lit up because it is the one talking. */
  highlight: number;
  /** 0 to 1: just did something good (a coin, the exit). */
  happy: number;
  time: number;
  /** Its personality colour (game/persona.ts), shown in its eyes; its body keeps its own colour, so who is who stays clear. */
  aura?: string | null;
}

function antenna(ctx: Ctx, shape: BotLook['antenna'], x: number, y: number, r: number): void {
  ctx.beginPath();
  switch (shape) {
    case 'circle':
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.05, y + r * 0.75);
      ctx.lineTo(x - r * 1.05, y + r * 0.75);
      break;
    case 'diamond':
      ctx.moveTo(x, y - r * 1.25);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r * 1.25);
      ctx.lineTo(x - r, y);
      break;
    case 'square':
      roundRect(ctx, x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8, r * 0.3);
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? r * 1.25 : r * 0.55;
        if (i === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      break;
    case 'heart':
      ctx.moveTo(x, y + r);
      ctx.bezierCurveTo(x - r * 1.6, y - r * 0.2, x - r * 0.6, y - r * 1.4, x, y - r * 0.5);
      ctx.bezierCurveTo(x + r * 0.6, y - r * 1.4, x + r * 1.6, y - r * 0.2, x, y + r);
      break;
    case 'ring':
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x + r * 0.45, y);
      ctx.arc(x, y, r * 0.45, 0, Math.PI * 2, true);
      break;
    case 'cross':
      ctx.rect(x - r * 0.3, y - r, r * 0.6, r * 2);
      ctx.rect(x - r, y - r * 0.3, r * 2, r * 0.6);
      break;
  }
  ctx.closePath();
}

export function drawBot(ctx: Ctx, s: Space, p: BotPose): void {
  if (p.opacity <= 0.01) return;
  const { X, Y, t } = s;
  const W = p.w * t;
  const H = p.h * t;
  const fx = X(p.x + p.w / 2);
  const fy = Y(p.y);
  const seed = hashOf(p.id);
  const airborne = p.anim === 'jump' || p.anim === 'fall';

  ctx.save();
  ctx.globalAlpha = p.opacity;

  // A soft glow behind whoever is talking.
  if (p.highlight > 0.01) {
    const g = ctx.createRadialGradient(fx, fy - H * 0.55, 0, fx, fy - H * 0.55, H * 1.25);
    g.addColorStop(0, alpha(p.look.main, 0.42 * p.highlight));
    g.addColorStop(1, alpha(p.look.main, 0));
    ctx.fillStyle = g;
    ctx.fillRect(fx - H * 1.3, fy - H * 1.8, H * 2.6, H * 2.6);
  }
  // Shadow on the ground (only when standing: in the air there's no telling where the ground is).
  if (!airborne && p.anim !== 'climb') {
    ctx.fillStyle = 'rgba(4, 7, 18, 0.4)';
    ctx.beginPath();
    ctx.ellipse(fx, fy, W * 0.62, t * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Squash on landing, stretch in the air, a bob in step with walking.
  let sx = 1;
  let sy = 1;
  if (p.squash > 0) {
    sx += 0.2 * p.squash;
    sy -= 0.17 * p.squash;
  } else if (p.anim === 'jump') {
    sx = 0.91;
    sy = 1.09;
  } else if (p.anim === 'fall') {
    sx = 0.95;
    sy = 1.05;
  }
  const walking = p.anim === 'walk' || p.anim === 'creep' || p.anim === 'push' || p.anim === 'crawl';
  const bob = walking ? -Math.abs(Math.sin(p.x * Math.PI * 2.2)) * t * 0.05 : p.anim === 'idle' ? Math.sin(p.time * 2 + seed * 7) * t * 0.012 : 0;
  const lean = walking ? clamp(p.vx * 0.025, -0.13, 0.13) : airborne ? clamp(p.vx * 0.012, -0.08, 0.08) : 0;
  ctx.translate(fx, fy + bob);
  ctx.rotate(lean);
  ctx.scale(sx, sy);

  // Arms, only when they're doing something: pushing, or holding a lever.
  if (p.anim === 'push' || p.anim === 'hold') {
    ctx.strokeStyle = p.look.dark;
    ctx.lineWidth = Math.max(2, t * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    const armY = -H * (p.anim === 'push' ? 0.42 : 0.55);
    ctx.moveTo(p.facing * W * 0.35, armY);
    ctx.lineTo(p.facing * W * 0.78, armY + (p.anim === 'hold' ? t * 0.12 : 0));
    ctx.stroke();
  }

  // Antenna, swaying with movement.
  const sway = clamp(-p.vx * 0.04, -0.45, 0.45) + Math.sin(p.time * 2.6 + seed * 11) * 0.05;
  const baseY = -H;
  const tipX = Math.sin(sway) * t * 0.3;
  const tipY = baseY - Math.cos(sway) * t * 0.3;
  ctx.strokeStyle = p.look.dark;
  ctx.lineWidth = Math.max(1.5, t * 0.05);
  ctx.beginPath();
  ctx.moveTo(0, baseY + t * 0.02);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  antenna(ctx, p.look.antenna, tipX, tipY, t * 0.095);
  ctx.fillStyle = p.look.light;
  ctx.fill('evenodd');
  ctx.strokeStyle = p.look.dark;
  ctx.lineWidth = Math.max(1, t * 0.035);
  ctx.stroke();

  // Body.
  const body = ctx.createLinearGradient(0, -H, 0, 0);
  body.addColorStop(0, p.look.light);
  body.addColorStop(0.28, p.look.main);
  body.addColorStop(1, p.look.dark);
  ctx.fillStyle = body;
  roundRect(ctx, -W / 2, -H, W, H, t * 0.24);
  ctx.fill();
  ctx.fillStyle = alpha('#ffffff', 0.16);
  roundRect(ctx, -W / 2 + t * 0.06, -H + t * 0.05, W * 0.28, H * 0.5, t * 0.12);
  ctx.fill();
  // Feet.
  ctx.fillStyle = alpha('#0b1024', 0.35);
  roundRect(ctx, -W / 2, -t * 0.14, W, t * 0.14, [0, 0, t * 0.24, t * 0.24]);
  ctx.fill();

  // Face screen and eyes.
  const faceW = W * 0.78;
  const faceH = t * 0.44;
  const faceY = -H + t * 0.17;
  ctx.fillStyle = '#121a33';
  roundRect(ctx, -faceW / 2, faceY, faceW, faceH, t * 0.13);
  ctx.fill();
  ctx.strokeStyle = alpha(p.look.light, 0.35);
  ctx.lineWidth = 1;
  ctx.stroke();
  const blinkPhase = (p.time + seed * 5) % 4.3;
  const blink = blinkPhase < 0.13 ? 0.15 : 1;
  let eyeW = t * 0.105;
  let eyeH = t * 0.16 * blink;
  if (p.anim === 'push') eyeH *= 0.45;
  if (p.anim === 'fall') {
    eyeW *= 1.12;
    eyeH *= 1.15;
  }
  const look = p.anim === 'climb' ? 0 : p.facing * t * 0.05;
  const eyeY = faceY + faceH / 2 + (p.anim === 'climb' ? -t * 0.05 : 0);
  const eyes = p.aura ? eyeGlow(p.aura) : '#effaff';
  ctx.shadowColor = p.aura ? eyes : p.look.light;
  ctx.shadowBlur = t * (p.aura ? 0.4 : 0.25);
  ctx.fillStyle = eyes;
  for (const side of [-1, 1]) {
    const ex = look + side * t * 0.105;
    if (p.happy > 0.3) {
      // Happy eyes: little arcs.
      ctx.strokeStyle = eyes;
      ctx.lineWidth = Math.max(1.5, t * 0.05);
      ctx.beginPath();
      ctx.arc(ex, eyeY + t * 0.03, eyeW * 0.6, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    } else {
      roundRect(ctx, ex - eyeW / 2, eyeY - eyeH / 2, eyeW, Math.max(1, eyeH), eyeW * 0.45);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;

  // Its letter, on its chest.
  const badgeY = -H * 0.36;
  ctx.fillStyle = alpha(p.look.ink, 0.7);
  ctx.beginPath();
  ctx.arc(0, badgeY, t * 0.17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = p.look.light;
  ctx.font = `800 ${Math.round(t * 0.24)}px Nunito, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.id, 0, badgeY + t * 0.01);
  ctx.restore();
}
