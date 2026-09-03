# -*- coding: utf-8 -*-
"""角色通道验收：把上岸/下水过渡段定格在几个时刻，看小物是不是在水豚后面。
用法: python _dev/shot_matte.py [seg] [t1,t2,...]   默认 t_a_swim 3.5,5,6.5,8.5"""
import asyncio, http.server, socketserver, threading, functools, os, sys
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.join(HERE, '..', 'src-mobile'); PORT = 8950
seg = sys.argv[1] if len(sys.argv) > 1 else 't_a_swim'
ts = [float(x) for x in (sys.argv[2] if len(sys.argv) > 2 else '3.5,5,6.5,8.5').split(',')]
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
        await pg.goto(f"http://127.0.0.1:{PORT}/index.html?demo=idle&scene=ink&rw=full2" + ("&matte=1" if os.environ.get("MATTE") else ""))
        await pg.wait_for_timeout(2500)
        await pg.evaluate(f"Scene.playOn(Scene.spare(), '{seg}', false)")
        await pg.wait_for_timeout(1500)
        print('matte loaded:', await pg.evaluate(f"!!(Scene.matte['{seg}'] && Scene.matte['{seg}'].sheets.every(i=>i.complete&&i.naturalWidth))"))
        # 🔴 本地 SimpleHTTPRequestHandler 不支持 Range，seek 会从头重载——只能真播到时刻再暂停
        for t in ts:
            await pg.evaluate(f"(()=>{{const v=Scene.cur(); v.currentTime=0; v.play();}})()")
            await pg.wait_for_timeout(int(t * 1000))
            await pg.evaluate("(()=>{const v=Scene.cur(); v.pause(); Scene.vt=v.currentTime; Scene.draw();})()")
            await pg.wait_for_timeout(200)
            print('t=', await pg.evaluate("Scene.cur().currentTime"))
            await pg.screenshot(path=os.path.join(HERE, f"_mt_{seg}_{t}" + ("_dbg" if os.environ.get("MATTE") else "") + ".png"))
        await b.close()
    print("JS 报错:", errs if errs else "无")
asyncio.run(main())
