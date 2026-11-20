/**
 * Colours and identities.
 *
 * Each bot is told apart four ways at once, so nobody has to rely on colour
 * alone (about 1 in 12 men can't tell some hues apart): its colour, the
 * letter on its body, the shape on its antenna, and its name tag. The same
 * colour follows the bot everywhere: bubbles, transcript, cast cards.
 *
 * The scene is a calm dusk: dark, quiet terrain with moonlit edges, so the
 * bots, the only saturated things on screen, are what the eye goes to.
 */
export interface BotLook {
  main: string;
  light: string;
  dark: string;
  /** Text colour on the bot's own colour. */
  ink: string;
  antenna: 'circle' | 'triangle' | 'diamond' | 'square' | 'star' | 'heart' | 'ring' | 'cross';
}

const LOOKS: Record<string, BotLook> = {
  A: { main: '#ff7b6e', light: '#ffc0b7', dark: '#c94b3f', ink: '#4a130d', antenna: 'circle' },
  B: { main: '#ffc54d', light: '#ffe4a1', dark: '#c98e12', ink: '#4a3300', antenna: 'triangle' },
  C: { main: '#45d49c', light: '#a8f0d2', dark: '#1b9466', ink: '#063b27', antenna: 'diamond' },
  D: { main: '#58aaff', light: '#b0d6ff', dark: '#2a6fc2', ink: '#08294d', antenna: 'square' },
  E: { main: '#bc8cff', light: '#ddc7ff', dark: '#7f52cc', ink: '#2c1458', antenna: 'star' },
  F: { main: '#ff8fc8', light: '#ffc9e4', dark: '#c4508c', ink: '#4a0f2d', antenna: 'heart' },
  G: { main: '#9be15d', light: '#cff3ae', dark: '#5e9e24', ink: '#213a07', antenna: 'ring' },
  H: { main: '#f2f2f2', light: '#ffffff', dark: '#a9a9b8', ink: '#22222e', antenna: 'cross' },
};

/**
 * A personality colour as eyes can show it: the same hue and saturation,
 * lifted to at least 68% lightness, so even a "dark greyish blue" reads
 * against a bot's dark face screen.
 */
export function eyeGlow(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${Math.round((h * 60 + 360) % 360)}, ${Math.round(s * 100)}%, ${Math.max(68, Math.round(l * 100))}%)`;
}

export function botLook(id: string): BotLook {
  return LOOKS[id] ?? (LOOKS.H as BotLook);
}

export const THEME = {
  skyTop: '#0d1433',
  skyBottom: '#40598f',
  /** A faint warm glow along the horizon, behind everything. */
  horizon: 'rgba(255, 176, 128, 0.10)',
  moon: 'rgba(255, 244, 220, 0.92)',
  hillFar: '#2f4373',
  hillNear: '#263760',
  terrainTop: '#222c52',
  terrainBottom: '#121831',
  terrainSide: '#384a76',
  lip: '#7e98cb',
  lipHighlight: '#cbdaf4',
  wood: '#c99358',
  woodDark: '#8f6031',
  woodLight: '#efc48b',
  metal: '#8b97b8',
  metalDark: '#4b5678',
  coin: '#ffd35c',
  coinDark: '#d99a1e',
  exit: '#8ff5d2',
  shadow: 'rgba(4, 7, 18, 0.45)',
} as const;

/** Each door and the plates and levers that open it share a colour, so you can see what opens what. */
export const WIRE_COLOURS = ['#5ee7ff', '#ff7ad9', '#c9f06b', '#ffa45c', '#a4a8ff'] as const;
