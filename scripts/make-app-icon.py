#!/usr/bin/env python3
"""生成「立体」Bolloon 应用图标（真光照着色，不是贴图）。

用 Lambert 漫反射 + Blinn-Phong 高光 + 边缘光 + 底部反弹光算一张球体渲染图，
4 倍超采样后缩放（抗锯齿），输出 1024 主图 + Android mipmap 全尺寸。

用法:
    python3 scripts/make-app-icon.py                     # 只出 1024 主图
    python3 scripts/make-app-icon.py --mipmaps           # 同时写入 rokid/glass 的 res/mipmap-*
"""
import argparse
import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 4                      # 超采样倍数
BASE = 1024
W = H = BASE * SS

# 品牌黄（HDR 线性值，sRGB 近似）
BRAND = np.array([0.86, 0.94, 0.02])
BG = np.array([0.043, 0.043, 0.043])


def normalize(v):
    return v / np.linalg.norm(v)


def render_sphere(xx, yy, cx, cy, r, light_dir, base, spec_power=48.0, rim=0.55):
    """返回 (rgb, alpha) —— 球体光照着色（xx/yy 为像素坐标网格，y 向下）。"""
    px = (xx - cx) / r
    py = (yy - cy) / r
    d2 = px * px + py * py
    inside = d2 <= 1.0
    z = np.sqrt(np.clip(1.0 - d2, 0.0, 1.0))
    # 法线（屏幕系：x 右、y 下、z 朝观察者）
    nx, ny, nz = px, py, z
    L = normalize(light_dir)
    diff = np.clip(nx * L[0] + ny * L[1] + nz * L[2], 0.0, 1.0)

    # 观察方向近似 (0,0,1) ⇒ 半程向量
    V = np.array([0.0, 0.0, 1.0])
    Hh = normalize(L + V)
    spec = np.clip(nx * Hh[0] + ny * Hh[1] + nz * Hh[2], 0.0, 1.0) ** spec_power

    # 边缘光：法线越垂直视线越亮（球边缘一圈亮边，立体感关键）
    edge = np.clip(1.0 - nz, 0.0, 1.0) ** 2.2

    # 底部反弹光（从下方往上打的弱光）
    bounce = np.clip(-ny, 0.0, 1.0) ** 2.0 * 0.22

    ambient = 0.16
    shade = ambient + 0.95 * diff + bounce
    rgb = base[None, None, :] * shade[:, :, None]
    rgb += (np.array([1.0, 1.0, 0.92])[None, None, :] * (0.85 * spec)[:, :, None])
    rgb += (np.array([1.0, 1.0, 0.75])[None, None, :] * (rim * edge)[:, :, None])
    rgb = np.clip(rgb, 0.0, 1.0)

    alpha = inside.astype(np.float64)
    return rgb, alpha


def over(dst, src_rgb, src_a):
    """src over dst（都是 float 数组，alpha 0..1）"""
    a = src_a[:, :, None]
    return dst * (1.0 - a) + src_rgb * a


def soft_shadow(shape, cx, cy, rx, ry, strength=0.75):
    """柔和投影：椭圆 + 高斯模糊（直接用 PIL）"""
    img = Image.new("L", (shape[1], shape[0]), 0)
    d = ImageDraw.Draw(img)
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=int(255 * strength))
    img = img.filter(ImageFilter.GaussianBlur(radius=rx * 0.28))
    return np.asarray(img, dtype=np.float64) / 255.0


def build():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)

    # 背景：近黑 + 极淡径向光
    canvas = np.ones((H, W, 3)) * BG[None, None, :]
    m = ((xx - W / 2) ** 2 + (yy - H * 0.56) ** 2) / (0.72 * W) ** 2
    glow = np.clip(1.0 - m, 0.0, 1.0) ** 2
    canvas += glow[:, :, None] * np.array([0.10, 0.11, 0.05])[None, None, :]

    # 主球 + 小球几何
    c1 = (W * 0.455, H * 0.475)
    r1 = W * 0.300
    c2 = (W * 0.715, H * 0.715)
    r2 = W * 0.118

    # 投影（先画，再叠球）
    sh = np.maximum(soft_shadow((H, W), c1[0], c1[1] + r1 * 0.92, r1 * 1.20, r1 * 0.42, 0.85),
                    soft_shadow((H, W), c2[0], c2[1] + r2 * 0.95, r2 * 1.15, r2 * 0.45, 0.7))
    canvas *= (1.0 - 0.85 * sh)[:, :, None]

    light = np.array([-0.55, -0.62, 0.56])          # 左上偏前
    rgb1, a1 = render_sphere(xx, yy, c1[0], c1[1], r1, light, BRAND)
    canvas = over(canvas, rgb1, a1)

    rgb2, a2 = render_sphere(xx, yy, c2[0], c2[1], r2, light, BRAND, spec_power=36.0, rim=0.45)
    canvas = over(canvas, rgb2, a2)

    # 圆角遮罩（图标形状）
    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=int(W * 0.22), fill=255)
    mask = np.asarray(mask, dtype=np.float64) / 255.0

    out = np.dstack([canvas, mask])
    img = Image.fromarray((out * 255).astype(np.uint8), mode="RGBA")
    return img.resize((BASE, BASE), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="app-icon-3d.png")
    ap.add_argument("--mipmaps", action="store_true")
    args = ap.parse_args()

    icon = build()
    icon.save(args.out)
    print(f"wrote {args.out} ({icon.size[0]}x{icon.size[1]})")

    if args.mipmaps:
        root = os.path.join(os.path.dirname(__file__), "..", "rokid", "glass", "app", "src", "main", "res")
        for dens, px in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
            d = os.path.join(root, f"mipmap-{dens}")
            os.makedirs(d, exist_ok=True)
            icon.resize((px, px), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))
            icon.resize((px, px), Image.LANCZOS).save(os.path.join(d, "ic_launcher_round.png"))
            print(f"  mipmap-{dens}: {px}x{px}")


if __name__ == "__main__":
    main()
