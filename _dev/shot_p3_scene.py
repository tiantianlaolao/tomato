# -*- coding: utf-8 -*-
"""P3 小物合成验收：两组物件（rw=full / rw=full2）× 空闲/休息(岸上)。用法: python _dev/shot_p3_scene.py"""
import asyncio, http.server, socketserver, threading, functools, os
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..', 'src-mobile')
PORT = 8943
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT), functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
SHOTS = [('full_idle', 'demo=idle&scene=ink&rw=full'), ('full2_idle', 'demo=idle&scene=ink&rw=full2'),
         ('full_break', 'demo=break&scene=ink&rw=full'), ('full2_break', 'demo=break&scene=ink&rw=full2')]
async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 430, "height": 932}, device_scale_factor=2)
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == 'error' else None)
        for tag, q in SHOTS:
            await pg.goto(f"http://127.0.0.1:{PORT}/index.html?{q}")
            await pg.wait_for_timeout(3000)
            await pg.screenshot(path=os.path.join(HERE, f"_p3s_{tag}.png"))
        await b.close()
    print("JS 报错:", errs if errs else "无")
asyncio.run(main())
