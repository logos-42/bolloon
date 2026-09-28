/**
 * efficode/crc32 - 包尾 CRC32 (IEEE 802.3, 多项式 0xEDB88320)
 *
 * 为什么自己写而不是用 zlib.crc32: 包层要能在**任何**运行面 (含手机 WebView 的
 * 纯 JS 上下文) 真算同一个校验值, 所以这里是不依赖 node:zlib 的纯实现。
 * 自证向量写在 src/test/efficode.test.ts: crc32("123456789") === 0xCBF43926 (规范值)。
 */

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 算 CRC32, 返回无符号 32 位整数 */
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 打包成 4 字节大端 */
export function crc32Bytes(buf: Uint8Array): Uint8Array {
  const v = crc32(buf);
  const out = new Uint8Array(4);
  out[0] = (v >>> 24) & 0xff;
  out[1] = (v >>> 16) & 0xff;
  out[2] = (v >>> 8) & 0xff;
  out[3] = v & 0xff;
  return out;
}

/** 从 4 字节大端读回 */
export function readCrc32Bytes(b: Uint8Array, offset = 0): number {
  return (((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0);
}
