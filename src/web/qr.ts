// ─── 扫码入网: 二维码编解码 (纯 JS, PC 出码 / 手机扫码) ─────────────────────
//   encode: qrcode → 终端 ASCII / dataURL; decode: jsQR (浏览器 camera/capture 图).
//   payload 是一份短文本: <网络链接>?name=..&ctx=<cid>&v=.., 手机 decode 后 detectGatewayLink → join.
import QRCode from 'qrcode';
import jsQR from 'jsqr';

export interface QrPayloadOpts {
  link: string;          // orbitdb:// | ipns:// | https://.../registry
  name?: string;
  ctxCid?: string;       // 共享 context CID
  version?: string;
}

/** 组装"扫码即入网"短文本 (链接 + 可选 query) */
export function buildQrPayload(o: QrPayloadOpts): string {
  let s = String(o.link || '').trim();
  const params = new URLSearchParams();
  if (o.name) params.set('name', o.name);
  if (o.ctxCid) params.set('ctx', o.ctxCid);
  if (o.version) params.set('v', o.version);
  const q = params.toString();
  if (q) s += (s.includes('?') ? '&' : '?') + q;
  return s;
}

/** 终端 ASCII 二维码 (半块字符 ▄█), 供 CLI /net qr 面板显示 */
export async function encodeQrTerminal(text: string): Promise<string> {
  try {
    const s = await QRCode.toString(text, { type: 'terminal', small: true });
    return s || '';
  } catch {
    return '';
  }
}

/** 浏览器/客户端图片二维码 (dataURL), 供 Web 端显示 */
export async function encodeQrDataUrl(text: string): Promise<string> {
  try {
    return await QRCode.toDataURL(text, { width: 320, margin: 2 });
  } catch {
    return '';
  }
}

/** 解码: 传入 RGBA 像素 (来自 canvas getImageData), 返回二维码文本或 null */
export function decodeQrImageData(data: Uint8ClampedArray, width: number, height: number): string | null {
  try {
    const r = jsQR(data, width, height);
    return r?.data ?? null;
  } catch {
    return null;
  }
}
