/**
 * A WAV file from raw samples: 16-bit PCM, mono. Kokoro gives 32-bit floats; 16 bits halve the files with no
 * difference anyone can hear in speech, and every browser plays them.
 */
export function wavFromSamples(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true); // the format chunk's size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // bytes a second
  v.setUint16(32, 2, true); // bytes a sample
  v.setUint16(34, 16, true); // bits a sample
  text(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}
