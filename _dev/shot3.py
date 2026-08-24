# -*- coding: utf-8 -*-
from pathlib import Path
from playwright.sync_api import sync_playwright
SRC = Path(r'D:\桌面\tomato\src\index.html').as_uri()
OUT = Path(r'D:\桌面\tomato\_dev')
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 780})
    pg = ctx.new_page()
    pg.add_init_script('localStorage.clear()')
    pg.goto(SRC); pg.wait_for_timeout(900)
    pg.click('#btnSettings'); pg.wait_for_timeout(400)
    pg.screenshot(path=str(OUT / '_t_m2_settings.png'))
    pg.click('#btnSchedules'); pg.wait_for_timeout(400)
    pg.screenshot(path=str(OUT / '_t_m2_schedule.png'))
    # 加一条每周计划验证列表渲染
    pg.click('#scRecGo'); pg.wait_for_timeout(400)
    pg.screenshot(path=str(OUT / '_t_m2_schedule2.png'))
    ctx.close(); b.close()
from PIL import Image
a = Image.open(OUT / '_t_m2_settings.png'); c = Image.open(OUT / '_t_m2_schedule2.png')
s = Image.new('RGB', (a.width * 2 + 30, a.height + 20), (240, 236, 230))
s.paste(a, (10, 10)); s.paste(c, (a.width + 20, 10)); s.save(OUT / '_sheet_m2.png')
print('ok')
