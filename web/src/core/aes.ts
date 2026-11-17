import * as aesjs from 'aes-js';

export function aes128EcbDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error('AES 数据长度必须是 16 的倍数');
  }
  const mode = new aesjs.ModeOfOperation.ecb(key);
  return new Uint8Array(mode.decrypt(data));
}

export function pkcs7Unpad(data: Uint8Array): Uint8Array {
  if (data.length === 0) throw new Error('空数据无法去除填充');
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16 || pad > data.length) {
    throw new Error('PKCS#7 填充无效');
  }
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) throw new Error('PKCS#7 填充无效');
  }
  return data.slice(0, data.length - pad);
}
