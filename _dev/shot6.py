# -*- coding: utf-8 -*-
# 桌宠小窗预览截图（浏览器模拟桌面背景；预览模式自动演：点烛→工作守烛）
from pathlib import Path
from playwright.sync_api import sync_playwright
SRC = Path(r'D:\桌面\tomato\src\pet.html').as_uri()
OUT = Path(r'D:\桌面\tomato\_dev')
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 280, 'height': 270}).new_page()
    pg.goto(SRC); pg.wait_for_timeout(1400)      # 召唤·点烛中
    pg.screenshot(path=str(OUT / '_p_summon.png'))
    pg.wait_for_timeout(2200)                     # 工作·守烛
    pg.screenshot(path=str(OUT / '_p_work.png'))
    pg.wait_for_timeout(1500)
    pg.screenshot(path=str(OUT / '_p_work2.png'))
    b.close()
print('ok')
