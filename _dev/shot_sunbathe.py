# -*- coding: utf-8 -*-
# 补验 sunbathe（夹具 break=900s 走吃瓜，短休段没截到）：强制喂 300s 短休
import asyncio, http.server, socketserver, threading, functools, os
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), 'src-mobile')
PORT = 8942
os.chdir(WEB)
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT),
                             functools.partial(http.server.SimpleHTTPRequestHandler))
threading.Thread(target=srv.serve_forever, daemon=True).start()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 430, "height": 932}, device_scale_factor=3)
        await pg.goto(f"http://127.0.0.1:{PORT}/index.html?demo=break&boxes=1")
        await pg.wait_for_timeout(2000)
        # 短休：本段 300 秒 → shortBreak → v3_sunbathe
        # 🔴 先掐掉 Scene.update：main.js 每秒喂真夹具（900s 长休）会把强制状态盖回去
        await pg.evaluate("Scene.update = () => {}")
        await pg.evaluate("Capy.onPhase('break', {stages:[{kind:'break',secs:300}], idx:0})")
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=os.path.join(HERE, "_m_sunbathe.png"))
        await b.close()

asyncio.run(main())
print('ok')
