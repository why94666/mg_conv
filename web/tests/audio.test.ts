import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeFlac, encodePcmToMp3, transcodeFlacToMp3 } from '../src/core/audio';
import { stripMp3Metadata, writeMp3Tags } from '../src/core/mp3';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

describe('audio pipeline', () => {
  it('decodes FLAC and encodes a real MP3', async () => {
    const flac = fixture('expected.flac');
    const pcm = await decodeFlac(flac);
    expect(pcm.channels.length).toBeGreaterThan(0);
    expect(pcm.sampleRate).toBeGreaterThan(0);

    const mp3 = encodePcmToMp3(pcm, 128);
    expect(mp3.length).toBeGreaterThan(1000);
    const first = Array.from(mp3.subarray(0, 2));
    expect(first[0]).toBe(0xff);
    expect(first[1] & 0xe0).toBe(0xe0);
  });

  it('transcodes FLAC to MP3 in one call', async () => {
    const mp3 = await transcodeFlacToMp3(fixture('expected.flac'), 128);
    expect(mp3.length).toBeGreaterThan(1000);
    expect(mp3[0]).toBe(0xff);
  });

  it('rewrites ID3 tags and keeps valid MPEG frames', async () => {
    const mp3 = await transcodeFlacToMp3(fixture('expected.flac'), 128);
    const tagged = writeMp3Tags(mp3, {
      title: '测试歌曲',
      artist: '测试歌手',
      album: '测试专辑',
      mode: 'artist',
      keepCover: false,
      cover: null,
    });
    expect(Array.from(tagged.subarray(0, 3))).toEqual([0x49, 0x44, 0x33]);
    const audio = stripMp3Metadata(tagged);
    expect(audio[0]).toBe(0xff);
    expect(audio[1] & 0xe0).toBe(0xe0);
  });
});
