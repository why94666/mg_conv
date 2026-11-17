export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error('文件截断：无法读取长度字段');
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

export function readU32BE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error('文件截断：无法读取长度字段');
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

export function syncSafeToInt(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

export function base64ToBytes(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const binary = atob(cleaned);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node fallback for tests
  return Uint8Array.from(Buffer.from(cleaned, 'base64'));
}

export function startsWith(bytes: Uint8Array, prefix: Uint8Array | number[]): boolean {
  const p = prefix instanceof Uint8Array ? prefix : Uint8Array.from(prefix);
  if (bytes.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (bytes[i] !== p[i]) return false;
  return true;
}

export function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
}

export function bytesToAscii(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
