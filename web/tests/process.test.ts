import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { processAudio, safeFilename } from '../src/core/process';
import { stripMp3Metadata } from '../src/core/mp3';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

describe('process pipeline', () => {
  it('turns an NCM file into a tagged MP3', async () => {
    const result = await processAudio(fixture('song.ncm'), 'song.ncm', {
      cleanMode: 'artist',
      keepCover: true,
      bitrate: 128,
    });
    expect(result.outputFormat).toBe('mp3');
    expect(result.sourceFormat).toBe('flac');
    expect(result.name).toBe('测试歌曲.mp3');
    expect(result.meta?.title).toBe('测试歌曲');
    expect(result.bytes.length).toBeGreaterThan(1000);

    const audio = stripMp3Metadata(result.bytes);
    expect(audio[0]).toBe(0xff);
    expect(audio[1] & 0xe0).toBe(0xe0);
  });

  it('cleans an NCM whose payload is already MP3 without re-encoding', async () => {
    const fixtureNcm = fixture('song_mp3.ncm');
    const result = await processAudio(fixtureNcm, 'song_mp3.ncm', {
      cleanMode: 'artist_album',
      keepCover: true,
      bitrate: 192,
    });
    expect(result.outputFormat).toBe('mp3');
    expect(result.sourceFormat).toBe('mp3');
    expect(result.name).toBe('测试歌曲MP3.mp3');
    expect(result.meta?.title).toBe('测试歌曲MP3');

    const audio = stripMp3Metadata(result.bytes);
    expect(audio[0]).toBe(0xff);
    expect(audio[1] & 0xe0).toBe(0xe0);
  });

  it('sanitizes output names', () => {
    expect(safeFilename('a/b:c*?"<>|')).toBe('a_b_c______');
    expect(safeFilename('   ')).toBe('audio');
    expect(safeFilename('测试歌曲')).toBe('测试歌曲');
  });
});
