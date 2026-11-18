import { decodeInput, finalizeDecoded, safeFilename, type ProcessOptions } from './core/process';
import { encodePcmToMp3 } from './core/audio';
import { writeMp3Tags } from './core/mp3';
import type { NcmCover, NcmMeta } from './core/ncm';

interface WorkerFileRequest {
  id: number;
  type?: 'file';
  buffer: ArrayBuffer;
  filename: string;
  options: ProcessOptions;
}

interface WorkerPcmRequest {
  id: number;
  type: 'pcm';
  channels: Float32Array[];
  sampleRate: number;
  filename: string;
  sourceFormat: string;
  meta?: NcmMeta | null;
  cover?: NcmCover | null;
  options: ProcessOptions;
}

type WorkerRequest = WorkerFileRequest | WorkerPcmRequest;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const { id, filename, options } = request;
  try {
    let bytes: Uint8Array;
    let name: string;
    let title: string;
    let sourceFormat: string;
    let warnings: string[] = [];
    let meta: NcmMeta | null = null;

    if (request.type === 'pcm') {
      sourceFormat = request.sourceFormat;
      meta = request.meta ?? null;
      title = safeFilename(meta?.title?.trim() || filename.replace(/\.[^.]+$/, ''), 'audio');
      const cover = request.cover ?? null;
      const rawMp3 = encodePcmToMp3(
        { channels: request.channels, sampleRate: request.sampleRate },
        options.bitrate,
        (fraction) =>
          ctx.postMessage({ id, type: 'progress', fraction: 0.2 + fraction * 0.75, stage: '转码 MP3' }),
      );
      bytes = writeMp3Tags(rawMp3, {
        title,
        artist: meta?.artist || '',
        album: meta?.album || '',
        cover,
        keepCover: options.keepCover && Boolean(cover),
        mode: options.cleanMode,
      });
      name = `${title}.mp3`;
    } else {
      const decoded = decodeInput(new Uint8Array(request.buffer), filename);
      if (decoded.format !== 'mp3' && decoded.format !== 'flac') {
        const audioBuffer = decoded.audio.buffer.slice(
          decoded.audio.byteOffset,
          decoded.audio.byteOffset + decoded.audio.byteLength,
        ) as ArrayBuffer;
        const coverBuffer = decoded.cover
          ? (decoded.cover.data.buffer.slice(
              decoded.cover.data.byteOffset,
              decoded.cover.data.byteOffset + decoded.cover.data.byteLength,
            ) as ArrayBuffer)
          : null;
        ctx.postMessage(
          {
            id,
            type: 'needs-decode',
            buffer: audioBuffer,
            filename,
            sourceFormat: decoded.format,
            meta: decoded.meta,
            cover: decoded.cover
              ? { data: new Uint8Array(coverBuffer as ArrayBuffer), mime: decoded.cover.mime }
              : null,
            options,
          },
          coverBuffer ? [audioBuffer, coverBuffer] : [audioBuffer],
        );
        return;
      }

      const result = await finalizeDecoded(decoded, filename, options, (fraction, stage) => {
        ctx.postMessage({ id, type: 'progress', fraction, stage });
      });
      bytes = result.bytes;
      name = result.name;
      title = result.title;
      sourceFormat = result.sourceFormat;
      warnings = result.warnings;
      meta = result.meta;
    }

    const out = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    ctx.postMessage(
      {
        id,
        type: 'done',
        buffer: out,
        name,
        title,
        sourceFormat,
        warnings,
        meta,
      },
      [out],
    );
  } catch (error) {
    ctx.postMessage({
      id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
