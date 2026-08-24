# -*- coding: utf-8 -*-
# 1024px 番茄图标：暖橙红圆果 + 绿蒂 + 高光，圆角底透明
from PIL import Image, ImageDraw
S = 1024
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# 果体：略扁的圆
cx, cy, r = S//2, S//2 + 60, 380
d.ellipse([cx-r, cy-int(r*0.92), cx+r, cy+int(r*0.92)], fill=(232, 89, 12, 255))
# 底部暗一圈做体积
d.ellipse([cx-r+40, cy-int(r*0.92)+70, cx+r-8, cy+int(r*0.92)-6], fill=(214, 77, 6, 255))
d.ellipse([cx-r+40, cy-int(r*0.92)+40, cx+r-40, cy+int(r*0.92)-40], fill=(232, 89, 12, 255))
# 高光
d.ellipse([cx-220, cy-260, cx-40, cy-120], fill=(255, 152, 96, 235))
d.ellipse([cx-190, cy-235, cx-90, cy-160], fill=(255, 196, 158, 255))
# 绿蒂：五片叶
import math
for i in range(5):
    a = -90 + i*72
    rad = math.radians(a)
    lx, ly = cx + 150*math.cos(rad), cy - 320 + 95*math.sin(rad)
    d.ellipse([lx-95, ly-52, lx+95, ly+52], fill=(12, 166, 120, 255))
d.ellipse([cx-60, cy-420, cx+60, cy-300], fill=(10, 140, 100, 255))
# 蒂梗
d.rounded_rectangle([cx-26, cy-470, cx+26, cy-340], radius=26, fill=(10, 140, 100, 255))
img.save(r'D:\桌面\tomato\_dev\icon-src.png')
print('icon-src.png ok')
