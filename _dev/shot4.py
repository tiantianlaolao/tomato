# -*- coding: utf-8 -*-
# 本轮验收截图：定时面板三选一 / 定点秒级 / 计时中右栏收起与展开
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
    pg.click('#btnSchedules'); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / '_t_r1_sc_delay.png'))
    pg.click('#scModeSeg button[data-mode="once"]'); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / '_t_r1_sc_once.png'))
    pg.click('#scModeSeg button[data-mode="recurring"]'); pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / '_t_r1_sc_rec.png'))
    pg.mouse.click(300, 500); pg.wait_for_timeout(300)  # 点空白收面板
    pg.click('#btnMain'); pg.wait_for_timeout(800)      # 开始 → 右栏应收起
    pg.screenshot(path=str(OUT / '_t_r1_run_collapsed.png'))
    pg.click('#btnToggleList'); pg.wait_for_timeout(400)
    pg.screenshot(path=str(OUT / '_t_r1_run_expanded.png'))
    ctx.close(); b.close()
print('ok')
