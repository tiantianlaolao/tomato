# -*- coding: utf-8 -*-
# 复验两处修改：a 编辑态副标题胶囊 / f 段间等待种子位置
import json, time
from pathlib import Path
from playwright.sync_api import sync_playwright
SRC = Path(r'D:\桌面\tomato\src\index.html').as_uri()
OUT = Path(r'D:\桌面\tomato\_dev')
CLASSIC = []
for i in range(4):
    CLASSIC.append({'kind':'work','secs':1500}); CLASSIC.append({'kind':'break','secs':900 if i==3 else 300})
AWAIT = {'status':'awaiting','plan_id':'classic','plan_name':'经典番茄','stages':CLASSIC,'idx':1,'end_ms':0,'remain_ms':0,'started_ms':int(time.time()*1000)-600000}
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, sess in [('a2_edit', None), ('f2_await', AWAIT)]:
        ctx = b.new_context(viewport={'width':1100,'height':720}); pg = ctx.new_page()
        pg.add_init_script('localStorage.clear();' + (f'localStorage.setItem("tm_session", {json.dumps(json.dumps(sess))});' if sess else ''))
        pg.goto(SRC); pg.wait_for_timeout(1400)
        pg.screenshot(path=str(OUT/f'_t_{name}.png')); print(name,'ok'); ctx.close()
    b.close()
from PIL import Image
a=Image.open(OUT/'_t_a2_edit.png'); f=Image.open(OUT/'_t_f2_await.png')
s=Image.new('RGB',(a.width*2+30,a.height+20),(240,236,230)); s.paste(a,(10,10)); s.paste(f,(a.width+20,10)); s.save(OUT/'_sheet3.png')
print('sheet3 ok')
