# -*- coding: utf-8 -*-
# 视觉验收：playwright 真等截图（rAF 动画必须真等，virtual-time-budget 推不动 rAF）。
# 七个状态各截一张：编辑态 / 工作燃烧 / 休息小苗 / 强制休息遮罩 / 暂停冻结 / 段间等待 / 完成态 / 窄窗堆叠。
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

SRC = Path(r'D:\桌面\tomato\src\index.html').as_uri()
OUT = Path(r'D:\桌面\tomato\_dev')

def seed(page, session=None, settings=None):
    page.add_init_script(f"""
      localStorage.clear();
      {'localStorage.setItem("tm_session", ' + json.dumps(json.dumps(session)) + ');' if session else ''}
      {'localStorage.setItem("tm_settings", ' + json.dumps(json.dumps(settings)) + ');' if settings else ''}
    """)

def run_session(idx, stages, status='running', remain_frac=0.5):
    now = int(time.time() * 1000)
    dur = stages[idx]['secs'] * 1000
    s = {
        'status': status, 'plan_id': 'classic', 'plan_name': '经典番茄',
        'stages': stages, 'idx': idx,
        'end_ms': now + int(dur * remain_frac) + 3600_000 * 0,  # running 时剩 remain_frac
        'remain_ms': int(dur * remain_frac),
        'started_ms': now - 600000,
    }
    if status == 'running':
        s['end_ms'] = now + int(dur * remain_frac)
    return s

CLASSIC = []
for i in range(4):
    CLASSIC.append({'kind': 'work', 'secs': 25 * 60})
    CLASSIC.append({'kind': 'break', 'secs': 15 * 60 if i == 3 else 5 * 60})

FORCED = {'auto_work_to_break': True, 'auto_break_to_work': False, 'rest_policy': 'forced',
          'final_break_unlock': False, 'sound_on': True, 'volume': 0.7, 'pre_alert_sec': 3,
          'theme': 'auto', 'selected_plan_id': 'classic', 'license': ''}

SHOTS = [
    ('a_edit',    None, None, (1100, 720)),
    ('b_work',    run_session(2, CLASSIC, 'running', 0.42), None, (1100, 720)),          # 工作中段：燃到一半
    ('c_break',   run_session(3, CLASSIC, 'running', 0.35), None, (1100, 720)),          # 休息：苗长了 65%
    ('d_forced',  run_session(3, CLASSIC, 'running', 0.5), FORCED, (1100, 720)),         # 强制休息遮罩
    ('e_paused',  run_session(2, CLASSIC, 'paused', 0.6), None, (1100, 720)),            # 暂停冻结
    ('f_await',   run_session(1, CLASSIC, 'awaiting', 0), None, (1100, 720)),            # 段间等待
    ('g_done',    {'status': 'done', 'plan_id': 'classic', 'plan_name': '经典番茄',
                   'stages': CLASSIC, 'idx': 7, 'end_ms': 0, 'remain_ms': 0,
                   'started_ms': int(time.time() * 1000) - 7200_000}, None, (1100, 720)),
    ('h_narrow',  run_session(0, CLASSIC, 'running', 0.7), None, (560, 820)),            # 窄窗堆叠
]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, session, settings, size in SHOTS:
        ctx = browser.new_context(viewport={'width': size[0], 'height': size[1]})
        page = ctx.new_page()
        seed(page, session, settings)
        page.goto(SRC)
        page.wait_for_timeout(1600)  # 真等：让 rAF 跑起来、火苗/小苗有形态
        page.screenshot(path=str(OUT / f'_t_{name}.png'))
        print(name, 'ok')
        ctx.close()
    browser.close()
print('ALL DONE')
