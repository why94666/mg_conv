import { startsWith } from './bytes';
import { decodeNcm, sniffAudioFormat, type AudioFormat, type NcmMeta } from './ncm';
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

function tagsFor(meta: NcmMeta | null, fallbackTitle: string, options: ProcessOptions) {
  return {
    title: meta?.title?.trim() || fallbackTitle,
    artist: meta?.artist || '',
    album: meta?.album || '',
    cover: meta ? null : null,
    keepCover: options.keepCover,
    mode: options.cleanMode,
  };
}

export async function processAudio(
  input: Uint8Array,
  filename: string,
  options: ProcessOptions,
  onProgress?: ProcessProgress,
): Promise<ProcessedAudio> {
  const stem = stripExtension(filename);
  const isNcm = startsWith(input, NCM_MAGIC) || filename.toLowerCase().endsWith('.ncm');

  let audio: Uint8Array = input;
  let sourceFormat: AudioFormat | 'ncm' = 'ncm';
  let meta: NcmMeta | null = null;
  let cover: { data: Uint8Array } | null = null;
  const warnings: string[] = [];

  if (isNcm) {
    onProgress?.(0.02, '解析 NCM');
    const decoded = decodeNcm(input);
    audio = decoded.audio;
    meta = decoded.meta;
    cover = decoded.cover ? { data: decoded.cover.data } : null;
    warnings.push(...decoded.warnings);
    sourceFormat = decoded.format;
  } else {
    sourceFormat = sniffAudioFormat(input.subarray(0, 16));
    onProgress?.(0.05, '读取音频');
  }

  if (sourceFormat === 'unknown') {
    throw new Error('无法识别音频格式，请确认文件没有损坏');
  }

  const title = meta?.title?.trim() || stem;
  const outputBase = safeFilename(title, stem || 'audio');
  const tagOptions = {
    ...tagsFor(meta, title, options),
    cover,
    keepCover: options.keepCover && Boolean(cover),
  };

  let mp3: Uint8Array;
  if (sourceFormat === 'mp3') {
    onProgress?.(0.35, '清理 MP3 标签');
    mp3 = writeMp3Tags(audio, tagOptions);
    onProgress?.(1, '完成');
  } else if (sourceFormat === 'flac') {
    onProgress?.(0.08, '解码 FLAC');
    const rawMp3 = await transcodeFlacToMp3(audio, options.bitrate, (fraction) => {
      onProgress?.(0.08 + fraction * 0.8, '转码 MP3');
    });
    onProgress?.(0.92, '写入标签');
    mp3 = writeMp3Tags(rawMp3, tagOptions);
    onProgress?.(1, '完成');
  } else {
    throw new Error(
      `暂不支持 ${sourceFormat.toUpperCase()} 格式转 MP3。当前支持 NCM、MP3、FLAC；M4A/AAC 会在后续版本支持。`,
    );
  }

  return {
    bytes: mp3,
    name: `${outputBase}.mp3`,
    title: outputBase,
    sourceFormat,
    outputFormat: 'mp3',
    warnings,
    meta,
  };
}
