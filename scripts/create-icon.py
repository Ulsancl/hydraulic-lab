"""Generate Hydraulic Lab's original cylinder-and-circuit PNG/ICO with Pillow.

This authoring helper is optional; packaged applications use the saved images.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
target = root / 'desktop' / 'assets'
target.mkdir(parents=True, exist_ok=True)
scale = 3
image = Image.new('RGBA', (512 * scale, 512 * scale), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
def xy(values): return tuple(round(value * scale) for value in values)
def line(values, color, width): draw.line(xy(values), fill=color, width=width * scale, joint='curve')
def box(values, radius, color, outline=None, width=1):
    draw.rounded_rectangle(xy(values), radius * scale, fill=color, outline=outline, width=width * scale)
def circle(values, color, outline=None, width=1):
    draw.ellipse(xy(values), fill=color, outline=outline, width=width * scale)

box((8, 8, 504, 504), 98, '#11252d', '#345962', 7)
# Cutaway double-acting cylinder: cap chamber, piston and exposed rod.
box((66, 112, 367, 274), 21, '#698a95', '#d5e7e8', 7)
box((85, 133, 347, 252), 6, '#213e48')
box((89, 140, 213, 245), 4, '#247e94')
box((238, 140, 343, 245), 4, '#b58f40')
box((209, 132, 242, 253), 5, '#d5e6e7', '#8baab4', 3)
line((218, 142, 218, 242), '#507b88', 4)
box((240, 173, 443, 211), 8, '#b9d4d9', '#edf5ed', 4)
circle((424, 164, 469, 220), '#3a6777', '#d5e7e8', 5)
circle((438, 179, 455, 205), '#132a34')
for x in (79, 350):
    for y in (125, 261): circle((x - 5, y - 5, x + 5, y + 5), '#233f4b')
# Separate supply and return paths to a directional valve and tank.
line((116, 273, 116, 327, 216, 327), '#39b4d1', 17)
line((323, 273, 323, 327, 275, 327), '#e1ae53', 17)
box((192, 299, 298, 368), 9, '#466c79', '#b5d1d5', 4)
line((208, 345, 236, 317), '#d7eaeb', 5)
line((257, 317, 283, 345), '#d7eaeb', 5)
line((232, 317, 236, 317, 236, 321), '#d7eaeb', 5)
line((279, 345, 283, 345, 283, 341), '#d7eaeb', 5)
line((218, 369, 218, 410, 157, 410), '#39b4d1', 14)
line((271, 369, 271, 424, 356, 424), '#e1ae53', 14)
circle((110, 383, 163, 436), '#264955', '#d3e6e6', 5)
draw.polygon(xy((133, 395, 151, 409, 133, 423)), fill='#39b4d1')
line((135, 436, 135, 453, 356, 453, 356, 415), '#8baab4', 6)
image = image.resize((512, 512), Image.Resampling.LANCZOS)
image.save(target / 'app.png')
image.save(target / 'app.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f'Hydraulic Lab icon: {target / "app.ico"}')
