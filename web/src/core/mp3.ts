import { ID3Writer } from 'browser-id3-writer';
import { readU32LE, startsWith, syncSafeToInt } from './bytes';

export type CleanMode = 'artist' | 'artist_album' | 'all';

export interface Mp3TagOptions {
  title?: string;
  artist?: string;
  album?: string;
  cover?: { data: Uint8Array } | null;
  keepCover: boolean;
  mode: CleanMode;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function findMpegSync(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) return i;
  }
  return -1;
}

/** Remove existing ID3v2 / ID3v1 so the output only has the tag we write. */
export function stripMp3Metadata(input: Uint8Array): Uint8Array {
  let start = 0;
  let end = input.length;

  if (input.length >= 10 && startsWith(input, [0x49, 0x44, 0x33])) {
    const size = syncSafeToInt(input, 6);
    const footer = (input[5] & 0x10) !== 0 ? 10 : 0;
    start = Math.min(input.length, 10 + size + footer);
  }

  if (end - start >= 128) {
    const tagAt = end - 128;
    if (
      input[tagAt] === 0x54 &&
      input[tagAt + 1] === 0x41 &&
      input[tagAt + 2] === 0x47
    ) {
      end = tagAt;
    }
  }

  // APEv2 footer: "APETAGEX" at the end. Drop the tag if its size is sane.
  if (end - start >= 32) {
    const apeAt = end - 32;
    if (
      input[apeAt] === 0x41 &&
      input[apeAt + 1] === 0x50 &&
      input[apeAt + 2] === 0x45 &&
      input[apeAt + 3] === 0x54 &&
      input[apeAt + 4] === 0x41 &&
      input[apeAt + 5] === 0x47 &&
      input[apeAt + 6] === 0x45 &&
      input[apeAt + 7] === 0x58
    ) {
      const apeSize = readU32LE(input, apeAt + 12);
      if (apeSize > 0 && apeSize < end - start) end = end - apeSize - 32;
    }
  }

  let audio = input.slice(start, end);
  const sync = findMpegSync(audio);
  if (sync < 0) throw new Error('不是有效的 MP3：找不到 MPEG 帧');
  if (sync > 0) audio = audio.slice(sync);
  return audio;
}

/** Strip old tags and write a clean ID3v2.3 tag. */
export function writeMp3Tags(input: Uint8Array, options: Mp3TagOptions): Uint8Array {
  const audio = stripMp3Metadata(input);
  const writer = new ID3Writer(toArrayBuffer(audio));

  if (options.title) writer.setFrame('TIT2', options.title);
  if (options.mode === 'artist' && options.album) writer.setFrame('TALB', options.album);
  if (options.keepCover && options.cover?.data.length) {
    writer.setFrame('APIC', {
      type: 3,
      data: toArrayBuffer(options.cover.data),
      description: '',
    });
  }

  return new Uint8Array(writer.addTag());
}

