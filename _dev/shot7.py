# -*- coding: utf-8 -*-
# 本轮验收截图：设置面板新项（预备音/桌宠）/ 记录面板 / 预设取名弹层 / 遮罩紧急出口
from pathlib import Path
from playwright.sync_api import sync_playwright
SRC = Path(r'D:\桌面\tomato\src\index.html').as_uri()
REST = Path(r'D:\桌面\tomato\src\rest.html').as_uri()
OUT = Path(r'D:\桌面\tomato\_dev')
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 780})
    pg = ctx.new_page()
    pg.add_init_script('localStorage.clear()')
    pg.goto(SRC); pg.wait_for_timeout(900)
    pg.click('#btnSettings'); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / '_t_r2_settings.png'))
    pg.mouse.click(300, 500); pg.wait_for_timeout(200)
    pg.click('#btnHistory'); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / '_t_r2_history.png'))
    pg.mouse.click(300, 500); pg.wait_for_timeout(200)
    pg.click('#btnPresets'); pg.wait_for_timeout(200)
    pg.click('#btnSaveAs'); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / '_t_r2_name_modal.png'))
    pg2 = ctx.new_page()
    pg2.goto(REST); pg2.wait_for_timeout(700)
    pg2.screenshot(path=str(OUT / '_t_r2_rest_urgent.png'))
    ctx.close(); b.close()
print('ok')
