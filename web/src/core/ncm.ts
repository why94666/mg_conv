import { aes128EcbDecrypt, pkcs7Unpad } from './aes';
import {
  asciiBytes,
  base64ToBytes,
  readU32LE,
  startsWith,
} from './bytes';

export type AudioFormat = 'mp3' | 'flac' | 'm4a' | 'ogg' | 'wav' | 'unknown';

export interface NcmMeta {
  title: string;
  artist: string;
  album: string;
  fmt: string;
  bitrate: number;
  duration: number;
  raw: Record<string, unknown>;
}

export interface NcmCover {
  data: Uint8Array;
  mime: string;
}

export interface DecodedNcm {
  audio: Uint8Array;
  format: AudioFormat;
  meta: NcmMeta | null;
  cover: NcmCover | null;
  warnings: string[];
}

const NCM_MAGIC = asciiBytes('CTENFDAM');
const NCM_GAP = 2;
const NCM_CORE_KEY = asciiBytes('hzHRAmso5kInbaxW');
const NCM_META_KEY = Uint8Array.from([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21, 0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28,
]);
const NCM_KEY_XOR = 0x64;
const NCM_META_XOR = 0x63;
const NCM_KEY_PREFIX = asciiBytes('neteasecloudmusic');
const NCM_META_PREFIX = asciiBytes("163 key(Don't modify):");
const NCM_META_PLAIN = asciiBytes('music:');
const MAX_SEGMENT = 64 * 1024 * 1024;

/** NCM uses a non-standard RC4 variant: 256-byte mask, no PRGA swap. */
export function streamCipher(key: Uint8Array): Uint8Array {
  if (key.length === 0) throw new Error('音频密钥为空');
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }

  const mask = new Uint8Array(256);
  for (let p = 0; p < 256; p++) {
    j = (p + 1) & 0xff;
    const a = s[j];
    const b = s[(a + j) & 0xff];
    mask[p] = s[(a + b) & 0xff];
  }
  return mask;
}

export function xorStream(data: Uint8Array, offset: number, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ mask[(offset + i) & 0xff];
  }
  return out;
}

export function sniffAudioFormat(head: Uint8Array): AudioFormat {
  if (startsWith(head, [0x66, 0x4c, 0x61, 0x43])) return 'flac'; // fLaC
  if (startsWith(head, [0x49, 0x44, 0x33])) return 'mp3'; // ID3
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    return 'm4a'; // ftyp
  }
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) return 'ogg'; // OggS
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46])) return 'wav'; // RIFF
  return 'unknown';
}

export function sniffCoverMime(data: Uint8Array): string {
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (
    data.length >= 12 &&
    startsWith(data, [0x52, 0x49, 0x46, 0x46]) &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function parseMeta(blob: Uint8Array): NcmMeta {
  if (!startsWith(blob, NCM_META_PREFIX)) {
    throw new Error('元数据段头部标记不正确');
  }
  let b64 = '';
  for (let i = NCM_META_PREFIX.length; i < blob.length; i++) b64 += String.fromCharCode(blob[i]);
  const encrypted = base64ToBytes(b64);
  const decrypted = pkcs7Unpad(aes128EcbDecrypt(NCM_META_KEY, encrypted));
  if (!startsWith(decrypted, NCM_META_PLAIN)) {
    throw new Error('元数据解密后缺少 music: 前缀');
  }
  const jsonText = new TextDecoder('utf-8', { fatal: false }).decode(decrypted.slice(NCM_META_PLAIN.length));
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('元数据不是 JSON 对象');
    }
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`元数据 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const artistValue = raw.artist;
  const artists: string[] = [];
  const collectArtist = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.trim()) artists.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectArtist(item);
    }
  };
  collectArtist(artistValue);

  return {
    title: typeof raw.musicName === 'string' ? raw.musicName : typeof raw.title === 'string' ? raw.title : '',
    artist: artists.join(' / '),
    album: typeof raw.album === 'string' ? raw.album : '',
    fmt: typeof raw.format === 'string' ? raw.format : '',
    bitrate: typeof raw.bitrate === 'number' ? raw.bitrate : 0,
    duration: typeof raw.duration === 'number' ? raw.duration : 0,
    raw,
  };
}

export function decodeNcm(input: ArrayBuffer | Uint8Array): DecodedNcm {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const warnings: string[] = [];

  if (bytes.length < 32) throw new Error(`文件过小（${bytes.length} 字节），不是有效的 NCM 文件`);
  if (!startsWith(bytes, NCM_MAGIC)) {
    throw new Error('不是 NCM 文件（文件头不是 CTENFDAM）');
  }

  let offset = NCM_MAGIC.length + NCM_GAP;
  const readU32 = (): number => {
    if (offset + 4 > bytes.length) throw new Error('文件截断：无法读取长度字段');
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const readBytes = (length: number, what: string): Uint8Array => {
    if (length < 0 || offset + length > bytes.length) throw new Error(`${what}不完整，文件可能被截断`);
    const out = bytes.slice(offset, offset + length);
    offset += length;
    return out;
  };

  const keyLen = readU32();
  if (keyLen === 0 || keyLen > 16384 || keyLen % 16 !== 0) {
    throw new Error(`密钥段长度异常（${keyLen} 字节）`);
  }
  const keyBlob = readBytes(keyLen, '密钥段').slice();
  for (let i = 0; i < keyBlob.length; i++) keyBlob[i] ^= NCM_KEY_XOR;
  let keyPlain: Uint8Array;
  try {
    keyPlain = pkcs7Unpad(aes128EcbDecrypt(NCM_CORE_KEY, keyBlob));
  } catch (error) {
    throw new Error(`密钥段解密失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!startsWith(keyPlain, NCM_KEY_PREFIX)) {
    throw new Error('密钥段解密后缺少 neteasecloudmusic 前缀');
  }
  const streamKey = keyPlain.slice(NCM_KEY_PREFIX.length);
  if (streamKey.length === 0) throw new Error('音频密钥为空');
  const mask = streamCipher(streamKey);

  const metaLen = readU32();
  if (metaLen > MAX_SEGMENT) throw new Error(`元数据段长度异常（${metaLen} 字节）`);
  let meta: NcmMeta | null = null;
  if (metaLen > 0) {
    const metaBlob = readBytes(metaLen, '元数据段').slice();
    for (let i = 0; i < metaBlob.length; i++) metaBlob[i] ^= NCM_META_XOR;
    try {
      meta = parseMeta(metaBlob);
    } catch (error) {
      warnings.push(`元数据解析失败（已降级为仅导出音频）：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    warnings.push('文件不含元数据段，将使用文件名作为标题');
  }

  readBytes(5, 'CRC 校验段');

  const frameLen = readU32();
  const imageLen = readU32();
  let cover: NcmCover | null = null;
  if (imageLen > 0) {
    const image = readBytes(imageLen, '封面图片');
    let pad = frameLen - imageLen;
    if (pad < 0) pad = 0;
    if (pad > 0) readBytes(pad, '封面帧填充');
    cover = { data: image, mime: sniffCoverMime(image) };
  } else if (frameLen > 0) {
    readBytes(frameLen, '封面帧');
  }

  const audioEncrypted = bytes.slice(offset);
  if (audioEncrypted.length === 0) throw new Error('NCM 文件中没有音频数据');
  const audio = xorStream(audioEncrypted, 0, mask);
  const format = sniffAudioFormat(audio.subarray(0, 16));
  if (format === 'unknown') {
    throw new Error('无法识别音频格式（解密结果不是 mp3/flac/m4a/ogg/wav），文件可能损坏');
  }

  return { audio, format, meta, cover, warnings };
}
