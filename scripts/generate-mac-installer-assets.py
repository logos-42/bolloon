from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path
import shutil, subprocess

root = Path(__file__).resolve().parent.parent
build = root / 'build'
src = Image.open(build / 'icon.png').convert('RGBA')
# macOS-style squircle: preserve the bright brand tile, soften only the outside corners.
size = 1024
src = src.resize((size, size), Image.Resampling.LANCZOS)
mask = Image.new('L', (size, size), 0)
d = ImageDraw.Draw(mask)
d.rounded_rectangle((8, 8, size-8, size-8), radius=205, fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(1.2))
out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
out.paste(src, (0, 0), mask)
out.save(build / 'icon-rounded.png')

# Build the standard macOS iconset from the rounded source.
iconset = build / 'icon.iconset'
if iconset.exists(): shutil.rmtree(iconset)
iconset.mkdir()
for px in (16, 32, 128, 256, 512):
    im = out.resize((px, px), Image.Resampling.LANCZOS)
    im.save(iconset / f'icon_{px}x{px}.png')
    im.resize((px*2, px*2), Image.Resampling.LANCZOS).save(iconset / f'icon_{px}x{px}@2x.png')
subprocess.run(['/usr/bin/iconutil', '-c', 'icns', '-o', str(build / 'icon-rounded.icns'), str(iconset)], check=True)
# Keep the active build icon sources aligned with the rounded design.
out.save(build / 'icon.png')
shutil.copy2(build / 'icon-rounded.icns', build / 'icon.icns')

# Installer background: brand yellow field, black mark, dark panel and explicit drag direction.
W, H = 1316, 996
bg = Image.new('RGB', (W, H), (244, 246, 61))
d = ImageDraw.Draw(bg)
d.rectangle((0, 0, W, 130), fill=(15, 15, 18))
d.rectangle((0, H-78, W, H), fill=(15, 15, 18))
d.rounded_rectangle((94, 214, W-94, H-178), radius=42, fill=(255, 255, 238), outline=(15, 15, 18), width=4)
# Center arrow and labels are intentionally secondary to electron-builder's icon placement.
d.line((W//2-80, H//2, W//2+80, H//2), fill=(15, 15, 18), width=14)
d.polygon([(W//2+80, H//2), (W//2+35, H//2-32), (W//2+35, H//2+32)], fill=(15, 15, 18))
d.text((76, 40), 'BOLLOON AGENT', fill=(244, 246, 61))
d.text((76, 76), '拖拽到 Applications 安装', fill=(235, 235, 235))
bg.save(build / 'dmg-background.png')
print('generated rounded icon, icns and dmg background')
