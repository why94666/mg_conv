import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeNcm, sniffAudioFormat, streamCipher } from '../src/core/ncm';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

describe('NCM decoder', () => {
  it('decrypts the synthetic NCM into the expected FLAC', () => {
    const decoded = decodeNcm(fixture('song.ncm'));
    const expected = fixture('expected.flac');

    expect(decoded.format).toBe('flac');
    expect(decoded.audio.length).toBe(expected.length);
    expect(Buffer.from(decoded.audio).equals(Buffer.from(expected))).toBe(true);
    expect(decoded.meta?.title).toBe('测试歌曲');
    expect(decoded.meta?.artist).toBe('测试歌手');
    expect(decoded.meta?.album).toBe('测试专辑');
    expect(decoded.cover).toBeNull();
    expect(decoded.warnings).toEqual([]);
  });

  it('recognizes common audio headers', () => {
    expect(sniffAudioFormat(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))).toBe('flac');
    expect(sniffAudioFormat(new Uint8Array([0x49, 0x44, 0x33]))).toBe('mp3');
    expect(sniffAudioFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3');
    expect(sniffAudioFormat(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe('ogg');
  });

  it('produces a stable 256-byte RC4 mask', () => {
    const mask = streamCipher(new Uint8Array([1, 2, 3, 4]));
    expect(mask).toHaveLength(256);
    expect(Array.from(mask.slice(0, 8))).toEqual([241, 183, 196, 219, 78, 46, 24, 44]);
  });
});
