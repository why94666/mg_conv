import { startsWith } from './bytes';
import { decodeNcm, sniffAudioFormat, type AudioFormat, type NcmCover, type NcmMeta } from './ncm';
import { writeMp3Tags, type CleanMode } from './mp3';
import { transcodeFlacToMp3 } from './audio';

export interface ProcessOptions {
  cleanMode: CleanMode;
  keepCover: boolean;
  bitrate: number;
}

export interface ProcessedAudio {
  bytes: Uint8Array;
  name: string;
  title: string;
  sourceFormat: AudioFormat | 'ncm';
  outputFormat: 'mp3';
  warnings: string[];
  meta: NcmMeta | null;
}

export interface DecodedInput {
  audio: Uint8Array;
  format: AudioFormat;
  meta: NcmMeta | null;
  cover: NcmCover | null;
  warnings: string[];
}

export interface ProcessProgress {
  (fraction: number, stage: string): void;
}

const NCM_MAGIC = [0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d]; // CTENFDAM

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function safeFilename(title: string, fallback = 'audio'): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export function decodeInput(input: Uint8Array, filename: string): DecodedInput {
  const isNcm = startsWith(input, NCM_MAGIC) || filename.toLowerCase().endsWith('.ncm');
  if (isNcm) {
    const decoded = decodeNcm(input);
    return {
      audio: decoded.audio,
      format: decoded.format,
      meta: decoded.meta,
      cover: decoded.cover,
      warnings: decoded.warnings,
    };
  }

  const format = sniffAudioFormat(input.subarray(0, 16));
  if (format === 'unknown') {
    throw new Error('无法识别音频格式，请确认文件没有损坏');
  }
  return { audio: input, format, meta: null, cover: null, warnings: [] };
}

export async function finalizeDecoded(
  decoded: DecodedInput,
  filename: string,
  options: ProcessOptions,
  onProgress?: ProcessProgress,
): Promise<ProcessedAudio> {
  const { audio, format, meta, cover, warnings } = decoded;
  if (format === 'unknown') {
    throw new Error('无法识别音频格式，请确认文件没有损坏');
  }

  const stem = stripExtension(filename);
  const title = meta?.title?.trim() || stem;
  const outputBase = safeFilename(title, stem || 'audio');
  const tagOptions = {
    title,
    artist: meta?.artist || '',
    album: meta?.album || '',
    cover,
    keepCover: options.keepCover && Boolean(cover),
    mode: options.cleanMode,
  };

  let mp3: Uint8Array;
  if (format === 'mp3') {
    onProgress?.(0.35, '清理 MP3 标签');
    mp3 = writeMp3Tags(audio, tagOptions);
    onProgress?.(1, '完成');
  } else if (format === 'flac') {
    onProgress?.(0.08, '解码 FLAC');
    const rawMp3 = await transcodeFlacToMp3(audio, options.bitrate, (fraction) => {
      onProgress?.(0.08 + fraction * 0.8, '转码 MP3');
    });
    onProgress?.(0.92, '写入标签');
    mp3 = writeMp3Tags(rawMp3, tagOptions);
    onProgress?.(1, '完成');
  } else {
    throw new Error(
      `暂不支持 ${format.toUpperCase()} 格式在 Worker 内转码；请走浏览器解码流程。`,
    );
  }

  return {
    bytes: mp3,
    name: `${outputBase}.mp3`,
    title: outputBase,
    sourceFormat: format,
    outputFormat: 'mp3',
    warnings,
    meta,
  };
}

export async function processAudio(
  input: Uint8Array,
  filename: string,
  options: ProcessOptions,
  onProgress?: ProcessProgress,
): Promise<ProcessedAudio> {
  const decoded = decodeInput(input, filename);
  return finalizeDecoded(decoded, filename, options, onProgress);
}
