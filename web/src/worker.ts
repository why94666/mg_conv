import { processAudio, safeFilename, type ProcessOptions } from './core/process';
import { encodePcmToMp3 } from './core/audio';
import { writeMp3Tags } from './core/mp3';

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
    let meta = null;

    if (request.type === 'pcm') {
      sourceFormat = request.sourceFormat;
      title = safeFilename(filename.replace(/\.[^.]+$/, ''), 'audio');
      const rawMp3 = encodePcmToMp3(
        { channels: request.channels, sampleRate: request.sampleRate },
        options.bitrate,
        (fraction) => ctx.postMessage({ id, type: 'progress', fraction: 0.2 + fraction * 0.75, stage: '转码 MP3' }),
      );
      bytes = writeMp3Tags(rawMp3, {
        title,
        artist: '',
        album: '',
        cover: null,
        keepCover: false,
        mode: options.cleanMode,
      });
      name = `${title}.mp3`;
    } else {
      const result = await processAudio(new Uint8Array(request.buffer), filename, options, (fraction, stage) => {
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
