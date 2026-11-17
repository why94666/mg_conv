import { FLACDecoder } from '@wasm-audio-decoders/flac';
import lamejs from '@breezystack/lamejs';

const MP3_RATES = new Set([32000, 44100, 48000]);

export interface DecodedPcm {
  channels: Float32Array[];
  sampleRate: number;
}

export interface EncodeProgress {
  (fraction: number): void;
}

export async function decodeFlac(data: Uint8Array): Promise<DecodedPcm> {
  const decoder = new FLACDecoder();
  try {
    await decoder.ready;
    const result = await decoder.decode(data);
    if (!result.channelData.length || !result.channelData[0]?.length) {
      const detail = result.errors?.[0]?.message || '没有解码出音频采样';
      throw new Error(`FLAC 解码失败：${detail}`);
    }
    return {
      channels: result.channelData.map((channel) => new Float32Array(channel)),
      sampleRate: result.sampleRate,
    };
  } finally {
    try {
      decoder.free();
    } catch {
      // ignore
    }
  }
}

function resampleChannel(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = to / from;
  const length = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i / ratio;
    const base = Math.floor(position);
    const fraction = position - base;
    const a = input[Math.min(base, input.length - 1)] ?? 0;
    const b = input[Math.min(base + 1, input.length - 1)] ?? a;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const value = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = Math.round(value < 0 ? value * 32768 : value * 32767);
  }
  return out;
}

export function encodePcmToMp3(pcm: DecodedPcm, bitrate = 192, onProgress?: EncodeProgress): Uint8Array {
  if (!pcm.channels.length) throw new Error('没有可编码的音频声道');
  const sourceRate = pcm.sampleRate;
  const targetRate = MP3_RATES.has(sourceRate) ? sourceRate : 44100;

  let left = pcm.channels[0];
  let right = pcm.channels[1] ?? pcm.channels[0];

  if (targetRate !== sourceRate) {
    left = resampleChannel(left, sourceRate, targetRate);
    right = right === pcm.channels[0] ? left : resampleChannel(right, sourceRate, targetRate);
  }

  const leftPcm = toInt16(left);
  const rightPcm = right === left ? leftPcm : toInt16(right);
  const encoder = new lamejs.Mp3Encoder(2, targetRate, bitrate);
  const blockSize = 1152;
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < leftPcm.length; offset += blockSize) {
    const end = Math.min(offset + blockSize, leftPcm.length);
    const chunk = encoder.encodeBuffer(leftPcm.subarray(offset, end), rightPcm.subarray(offset, end));
    if (chunk.length) chunks.push(new Uint8Array(chunk));
    onProgress?.(end / leftPcm.length);
  }

  const tail = encoder.flush();
  if (tail.length) chunks.push(new Uint8Array(tail));

  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  onProgress?.(1);
  return output;
}

export async function transcodeFlacToMp3(
  flac: Uint8Array,
  bitrate = 192,
  onProgress?: EncodeProgress,
): Promise<Uint8Array> {
  const pcm = await decodeFlac(flac);
  return encodePcmToMp3(pcm, bitrate, onProgress);
}
