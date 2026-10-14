/** Geradores de arquivos de áudio válidos para testes (sem depender de arquivos binários no repo). */
export function makeWav(ms: number, sampleRate = 8_000): Buffer {
  const samples = Math.round((sampleRate * ms) / 1000);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((index / sampleRate) * 2 * Math.PI * 440) * 8_000), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** MP3 CBR 128 kbps/44,1 kHz com N quadros de silêncio (418 bytes cada). */
export function makeMp3(frames: number): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

/** Ogg/Opus mínimo: cabeçalho + página final com granule position. */
export function makeOggOpus(ms: number): Buffer {
  const head = Buffer.alloc(64);
  head.write('OggS', 0);
  head.write('OpusHead', 28);
  head.writeUInt16LE(312, 38); // pre-skip
  const last = Buffer.alloc(32);
  last.write('OggS', 0);
  last.writeBigUInt64LE(BigInt(Math.round((ms / 1000) * 48_000) + 312), 6);
  return Buffer.concat([head, last]);
}
