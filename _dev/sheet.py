# -*- coding: utf-8 -*-
from PIL import Image
from pathlib import Path
d = Path(r'D:\桌面\tomato\_dev')
names = ['a_edit','b_work','c_break','d_forced','e_paused','f_await','g_done','h_narrow']
imgs = [Image.open(d/f'_t_{n}.png') for n in names]
for gi in range(2):
    four = imgs[gi*4:(gi+1)*4]
    w = max(i.width for i in four); rh = max(i.height for i in four)
    sheet = Image.new('RGB', (w*2+30, rh*2+30), (240,236,230))
    for k,im in enumerate(four):
        sheet.paste(im, ((k%2)*(w+10)+10, (k//2)*(rh+10)+10))
    sheet.save(d/f'_sheet{gi+1}.png')
print('sheets ok')
