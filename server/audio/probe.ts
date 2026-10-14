/**
 * Identifica o formato pelo conteúdo (assinatura binária), nunca pela extensão ou pelo
 * Content-Type enviado. Calcula a duração quando o formato permite.
 */
export type AudioFormat = 'mp3' | 'wav' | 'ogg';

export interface ProbeResult {
  format: AudioFormat;
  mime: string;
  /** null quando não é possível calcular com segurança (ex.: MP3 VBR sem cabeçalho Xing). */
  durationMs: number | null;
}

const MIME: Record<AudioFormat, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };

export function probeAudio(data: Buffer): ProbeResult | null {
  if (data.length < 12) return null;
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
    return { format: 'wav', mime: MIME.wav, durationMs: wavDuration(data) };
  }
  if (data.toString('ascii', 0, 4) === 'OggS') {
    return { format: 'ogg', mime: MIME.ogg, durationMs: oggDuration(data) };
  }
  const mp3Start = mp3FrameOffset(data);
  if (mp3Start !== null) return { format: 'mp3', mime: MIME.mp3, durationMs: mp3Duration(data, mp3Start) };
  return null;
}

function wavDuration(data: Buffer): number | null {
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= data.length) byteRate = data.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const available = Math.min(size, data.length - offset - 8);
      return Math.round((available / byteRate) * 1000);
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function oggDuration(data: Buffer): number | null {
  let sampleRate = 0;
  let preSkip = 0;
  const opus = data.indexOf('OpusHead');
  if (opus >= 0 && opus + 16 <= data.length) {
    sampleRate = 48_000;
    preSkip = data.readUInt16LE(opus + 10);
  } else {
    const vorbis = data.indexOf(Buffer.from([0x01, ...Buffer.from('vorbis')]));
    if (vorbis >= 0 && vorbis + 16 <= data.length) sampleRate = data.readUInt32LE(vorbis + 12);
  }
  if (!sampleRate) return null;
  const last = data.lastIndexOf('OggS');
  if (last < 0 || last + 14 > data.length) return null;
  const granule = Number(data.readBigUInt64LE(last + 6));
  if (!Number.isFinite(granule) || granule <= 0) return null;
  return Math.round(((granule - preSkip) / sampleRate) * 1000);
}

// MPEG-1 Layer III (kbps) e MPEG-2/2.5 Layer III
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

function mp3FrameOffset(data: Buffer): number | null {
  let offset = 0;
  if (data.toString('ascii', 0, 3) === 'ID3' && data.length > 10) {
    const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    offset = 10 + size;
  }
  const limit = Math.min(data.length - 4, offset + 4096);
  for (let index = offset; index <= limit; index += 1) {
    if (data[index] === 0xff && (data[index + 1] & 0xe0) === 0xe0 && parseFrame(data, index)) return index;
  }
  return null;
}

function parseFrame(data: Buffer, offset: number) {
  const b1 = data[offset + 1];
  const b2 = data[offset + 2];
  const version = (b1 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b1 >> 1) & 0x03; // 1 = Layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex];
  const sampleRate = RATES[version][rateIndex];
  return { version, kbps, sampleRate, samplesPerFrame: version === 3 ? 1152 : 576, channelMode: (data[offset + 3] >> 6) & 0x03 };
}

function mp3Duration(data: Buffer, offset: number): number | null {
  const frame = parseFrame(data, offset);
  if (!frame) return null;
  // Cabeçalho Xing/Info (VBR): número exato de quadros.
  const sideInfo = frame.version === 3 ? (frame.channelMode === 3 ? 17 : 32) : (frame.channelMode === 3 ? 9 : 17);
  const xing = offset + 4 + sideInfo;
  const tag = data.toString('ascii', xing, xing + 4);
  if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= data.length && (data.readUInt32BE(xing + 4) & 0x1)) {
    const frames = data.readUInt32BE(xing + 8);
    return Math.round((frames * frame.samplesPerFrame / frame.sampleRate) * 1000);
  }
  // CBR: estimativa pelo tamanho do fluxo.
  return Math.round(((data.length - offset) * 8) / frame.kbps);
}
