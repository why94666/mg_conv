import type { DecodedPcm } from './audio';

/**
 * Fallback decoder for formats the WASM FLAC decoder doesn't cover
 * (M4A/AAC/OGG/WAV). Uses the browser's native codecs, so support depends on
 * the browser; Chrome, Edge and Safari cover AAC/M4A.
 */
export async function decodeWithAudioContext(data: Uint8Array): Promise<DecodedPcm> {
  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('当前浏览器不支持音频解码');

  const ctx = new AudioContextCtor();
  try {
    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const audio = await ctx.decodeAudioData(arrayBuffer);
    const channels: Float32Array[] = [];
    for (let i = 0; i < audio.numberOfChannels; i++) {
      channels.push(new Float32Array(audio.getChannelData(i)));
    }
    return { channels, sampleRate: audio.sampleRate };
  } catch (error) {
    throw new Error(`浏览器无法解码该音频：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}
