from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import math

out = Path(r"C:\Users\Intelli\Desktop\ahsanWeb\backend\scripts\demo-product.png")
W = H = 900

img = Image.new("RGB", (W, H))
px = img.load()
for y in range(H):
    t = y / (H - 1)
    r = int(248 - 40 * t)
    g = int(232 - 70 * t)
    b = int(224 - 80 * t)
    for x in range(W):
        px[x, y] = (r, g, b)

d = ImageDraw.Draw(img, "RGBA")
# soft circles
d.ellipse((80, 120, 480, 520), fill=(255, 214, 196, 120))
d.ellipse((420, 380, 840, 800), fill=(214, 180, 150, 110))
d.rounded_rectangle((70, 620, 830, 820), radius=28, fill=(255, 255, 255, 200))

try:
    title = ImageFont.truetype("segoeuib.ttf", 74)
    sub = ImageFont.truetype("segoeui.ttf", 34)
    small = ImageFont.truetype("segoeui.ttf", 26)
except Exception:
    title = sub = small = ImageFont.load_default()

d.text((90, 640), "ZAMZAM", font=title, fill=(60, 40, 30))
d.text((92, 720), "Rose Gold Paddle Brush", font=sub, fill=(90, 64, 48))
d.text((92, 768), "DEMO PRODUCT  -  SKU ZAM-DEMO-1001", font=small, fill=(130, 100, 80))
d.text((90, 90), "DEMO IMAGE", font=sub, fill=(255, 255, 255))

img.save(out, format="PNG", optimize=True)
print(out, out.stat().st_size)
