# -*- coding: utf-8 -*-
"""汤札页截图：周牌 + 本月/全年小牌墙，中/英。用法: python _dev/shot_stamps.py"""
import asyncio, http.server, socketserver, threading, functools, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..', 'src-mobile'); PORT = 8948
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 430, "height": 932}, device_scale_factor=2)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == 'error' else None)
        for lang in ('zh', 'en'):
            await pg.goto(f"http://127.0.0.1:{PORT}/index.html?demo=idle&scene=ink&sheet=hist&tab=stamps&lang={lang}")
            await pg.wait_for_timeout(2500)
            await pg.screenshot(path=os.path.join(HERE, f"_st_{lang}_month.png"))
            await pg.get_by_role("button", name=("今年" if lang == "zh" else "Year")).click()
            await pg.wait_for_timeout(800)
            print(lang, "year btn on?", await pg.evaluate("document.querySelector('.tabs.sm button:nth-child(2)').className"))
            await pg.evaluate("document.getElementById('sheetBody').scrollTop = 520")
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=os.path.join(HERE, f"_st_{lang}_year.png"))
        await b.close()
    print("JS 报错:", errs if errs else "无")
asyncio.run(main())
