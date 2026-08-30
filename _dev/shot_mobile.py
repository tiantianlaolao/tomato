# -*- coding: utf-8 -*-
"""移动端渲染层截图验收。

🔴 这个脚本和它的产物**绝对不能放在 src-mobile/ 里**——那个目录就是
   frontendDist，里面的一切都会被 tauri 的 generate_context! 编译进
   app 二进制。第一版扔进去过，2.8MB 的截图差点跟着进包（真前端才 23KB）。

🔴 rAF 动画必须 playwright 真等：--virtual-time-budget 推不动 rAF（老坑，复撞过）。

用法：python _dev/shot_mobile.py       产物落在 _dev/（*.png 已被 .gitignore 挡掉）
"""
import asyncio, http.server, socketserver, threading, functools, os, sys
from playwright.async_api import async_playwright
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), 'src-mobile')
PORT = 8941
# 状态值照抄内核真相：idle/running/paused/awaiting/done（**没有 work/break**）
STATES = ['idle', 'running', 'grace', 'pre', 'break', 'forced', 'awaiting', 'paused', 'done']

os.chdir(WEB)
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", PORT),
                             functools.partial(http.server.SimpleHTTPRequestHandler))
threading.Thread(target=srv.serve_forever, daemon=True).start()


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 430, "height": 932}, device_scale_factor=3)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.type + ": " + m.text) if m.type == "error" else None)
        for s in STATES:
            await pg.goto(f"http://127.0.0.1:{PORT}/index.html?demo={s}")
            await pg.wait_for_timeout(3000)          # 真等，让 rAF 跑起来
            await pg.screenshot(path=os.path.join(HERE, f"_m_{s}.png"))
        # 三块面板（编排/设置/记录）——桌面端核心功能的手机实现，各截一张
        for k in ('edit', 'set', 'hist'):
            await pg.goto(f"http://127.0.0.1:{PORT}/index.html?demo=idle&sheet={k}")
            await pg.wait_for_timeout(1500)
            await pg.screenshot(path=os.path.join(HERE, f"_m_sheet_{k}.png"))
        # 叠加层帧率实测（视频状态机版：drawFx 已退役，钩 draw；视频本身 24fps 硬解不在此数）
        fps = await pg.evaluate("""async () => {
            let n = 0; const d0 = Scene.draw.bind(Scene);
            Scene.draw = function () { n++; return d0(); };
            await new Promise(r => setTimeout(r, 3000));
            return n / 3;
        }""")
        print("叠加层帧率 = %.1f fps（目标 8）" % fps)
        print("JS 报错:", errs or "无")
        await b.close()
        return len(errs)


rc = asyncio.run(main())
srv.shutdown()

ims = [Image.open(os.path.join(HERE, f"_m_{s}.png")).resize((330, 715), Image.LANCZOS) for s in STATES]
c = Image.new("RGB", (330 * len(ims) + 12 * (len(ims) - 1), 715), (18, 15, 12))
for i, im in enumerate(ims):
    c.paste(im, (i * (330 + 12), 0))
c.save(os.path.join(HERE, "_m_states.png"))
print("拼图 _dev/_m_states.png", c.size, "顺序:", STATES)
sys.exit(1 if rc else 0)
