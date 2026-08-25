# -*- coding: utf-8 -*-
# 集成验收：主窗口=水豚舞台（浏览器假内核）
# 空闲 / 点开始(召唤) / 工作守烛+木牌 / 切键盘 / 5秒冲刺跑到休息段
from pathlib import Path
from playwright.sync_api import sync_playwright
SRC = Path(r'D:\桌面\tomato\src\index.html').as_uri()
OUT = Path(r'D:\桌面\tomato\_dev')
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 780})
    pg = ctx.new_page()
    pg.add_init_script('localStorage.clear()')
    pg.goto(SRC); pg.wait_for_timeout(1500)
    pg.screenshot(path=str(OUT / '_i_idle.png'))
    pg.click('#btnMain'); pg.wait_for_timeout(1300)      # 召唤·点烛中
    pg.screenshot(path=str(OUT / '_i_summon.png'))
    pg.wait_for_timeout(2200)                             # 工作·守烛
    pg.screenshot(path=str(OUT / '_i_work.png'))
    pg.click('#actRow button[data-a="typing"]'); pg.wait_for_timeout(900)
    pg.screenshot(path=str(OUT / '_i_typing.png'))
    # 结束会话 → 换 5 秒冲刺预设跑到休息段
    pg.click('#btnStop'); pg.wait_for_timeout(300)
    pg.click('#toast button'); pg.wait_for_timeout(2600)  # 确定结束 → 放弃离场动画
    pg.click('#btnPresets'); pg.wait_for_timeout(400)
    pg.click('text=5 秒冲刺（测试）'); pg.wait_for_timeout(400)
    pg.click('#btnMain'); pg.wait_for_timeout(7500)       # 5s工作(含召唤)→自动进休息
    pg.screenshot(path=str(OUT / '_i_rest.png'))
    ctx.close(); b.close()
print('ok')
