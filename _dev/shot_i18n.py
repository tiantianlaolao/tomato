# -*- coding: utf-8 -*-
"""英文界面截图（?lang=en）：两主题主要状态 + 三个面板。用法: python _dev/shot_i18n.py"""
import asyncio, http.server, socketserver, threading, functools, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..', 'src-mobile'); PORT = 8957
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
SHOTS = [('ink_idle','demo=idle&scene=ink&rw=full'),('ink_run','demo=running&scene=ink'),('ink_break','demo=break&scene=ink'),('ink_done','demo=done&scene=ink'),
         ('onsen_idle','demo=idle&scene=onsen'),('onsen_run','demo=running&scene=onsen'),
         ('sheet_start','demo=idle&scene=ink&sheet=start'),('sheet_edit','demo=idle&scene=ink&sheet=edit'),('sheet_set','demo=idle&scene=ink&sheet=set'),
         ('sheet_stamps','demo=idle&scene=ink&sheet=hist&tab=stamps&rw=full'),('sheet_towels','demo=idle&scene=ink&sheet=hist&tab=towels&rw=full'),('sheet_garden','demo=idle&scene=ink&sheet=hist&tab=garden&rw=full')]
async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={"width": 430, "height": 932}, device_scale_factor=2)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        for tag, q in SHOTS:
            await pg.goto(f"http://127.0.0.1:{PORT}/index.html?{q}&lang=en"); await pg.wait_for_timeout(2500)
            await pg.screenshot(path=os.path.join(HERE, f"_en_{tag}.png"))
        await b.close()
    print("JS 报错:", errs if errs else "无")
asyncio.run(main())
