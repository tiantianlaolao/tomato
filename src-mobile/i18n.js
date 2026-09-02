// 双语层（2026-09-02 全球发布定案：中英双语起步，跟随系统语言）。
//
// 做法：**不改现有一百多处中文字面量**。字典以中文原句为键，页面渲染后由 MutationObserver
// 把文本节点按字典替换成英文；带数字的句子用模板（{n}）匹配。中文时整层不工作。
// 画布上的字（场景菜单词、题壁词）不在 DOM 里，由场景包读 I18N.lang 自己选词。
// Rust 发来的拒绝理由/内置预设名也在这里翻（内核只发中文；系统通知例外，内核按 settings.lang 选）。
//
// 🔴 加了新中文文案 → 来这里补一条，否则英文界面会露中文（不报错）。
(function () {
'use strict';

let lang = 'zh';
try {
  const q = new URLSearchParams(location.search).get('lang');
  const saved = localStorage.getItem('capy_lang');
  const sys = (navigator.language || 'zh').toLowerCase();
  lang = q || saved || (sys.startsWith('zh') ? 'zh' : 'en');
} catch (e) {}

// ── 字典：中文原句 → 英文。{n} 为数字占位；键里的 {n} 会编译成 (\d+) ──
const D = {
  // 场景包
  '野天风吕': 'Mountain Onsen', '水墨庭院': 'Ink Courtyard', '山中野天风吕': 'Mountain Onsen',
  '牌上三行都能点：入浴＝开始 · 汤加减＝设置 · 汤帐＝记录': 'Tap the sign: Soak = start · Tune = settings · Log = records',
  '墙上三个词都能点：汤沐＝开始 · 调汤＝设置 · 沐录＝记录': 'Tap the words on the wall: Soak = start · Tune = settings · Log = records',
  // 面板标题 / 入口
  '编排': 'Plan', '设置': 'Settings', '记录': 'Records', '今天泡多久': 'How long today?', '收起': 'Close',
  '汤沐': 'Soak', '调汤': 'Tune', '沐录': 'Log', '入 浴': 'Soak', '汤加减': 'Tune', '汤 帐': 'Log',
  // 运行中
  '暂停': 'Pause', '继续': 'Resume', '跳过这段': 'Skip', '开始下一段': 'Start next',
  '去泡一会儿（{n} 分钟）': 'Go soak ({n} min)', '开始下一段（{n} 分钟）': 'Start next ({n} min)',
  '长按结束': 'Hold to end', '强制休息中 · 按住 5 秒才能结束': 'Forced rest · hold 5 s to end',
  '长按结束 · 开始 {n} 秒内结束不计代价': 'Hold to end · free within {n} s of starting',
  '长按结束 · 本段不计入': 'Hold to end · this block won\'t count',
  // 完成卡
  '这一场结束了': 'Session complete', '好': 'OK',
  '专注 {n} 段 · 休息 {m}': 'Focus {n} blocks · rest {m}',
  '{n} 小时 {m} 分': '{n} h {m} min', '{n} 分钟': '{n} min', '{n} 分': '{n} min', '{n} 秒': '{n} s',
  '手拭巾·{s} 还差 {n} 分钟': 'Towel · {s}: {n} min to go', '手拭巾·{s} 可以领了': 'Towel · {s} is ready',
  '可用 {n} 分钟': '{n} min available',
  // 编排
  '自己编排一支': 'Make your own', '临时编排': 'Custom plan', '我的编排 {n}': 'My plan {n}',
  '长按一支自定义的可以删掉；长按内置的会载进编排器当底子改。': 'Long-press a custom plan to delete it; long-press a built-in one to edit a copy.',
  '删除预设「{s}」？': 'Delete preset "{s}"?', '算了': 'Cancel', '删掉': 'Delete',
  '共 {n} 段 · 专注 {m} 分 · 休息 {k} 分（休息约为专注的 {p}%）': '{n} blocks · focus {m} min · rest {k} min (rest ≈ {p}% of focus)',
  ' —— 休息偏少，容易撑不到最后': ' — rest is light; you may not last',
  '序列（点左边那格切工作／休息）': 'Sequence (tap the left cell to toggle work / rest)',
  '工作': 'Work', '休息': 'Rest', '段数': 'Blocks', '末段': 'Last rest',
  '+ 工作 25 分': '+ Work 25 min', '+ 休息 5 分': '+ Rest 5 min',
  '快捷生成': 'Quick build', '按上面四个数生成序列': 'Build from the four numbers above',
  '四个数依次是：工作分钟、几段、休息分钟、最后一段休息分钟': 'Work minutes, number of blocks, rest minutes, last rest minutes',
  '存为预设': 'Save as preset', '给它起个名字': 'Give it a name', '直接开始': 'Start now',
  '列表里长按一支自定义预设可以删掉它（内置的删不了）': 'Long-press a custom preset in the list to delete it (built-ins can\'t be deleted)',
  '经典番茄': 'Classic Pomodoro', '深度专注': 'Deep Focus', '小憩一下': 'Short Break', '90 / 20 深工作': '90 / 20 Deep Work', '5 秒冲刺（测试）': '5-second sprint (test)',
  '{n} 段 · 专注 {m}': '{n} blocks · focus {m}', '专注 {n} 段': 'Focus {n} blocks', '休息 {n} 分钟': 'Rest {n} min', '休息 {n} 分': 'Rest {n} min',
  // 设置
  '读不到设置': 'Couldn\'t load settings', '场景': 'Scene', '主题': 'Theme', '换一个院子陪你（切换即生效）': 'Pick a place to soak (applies at once)',
  '显示购买（开发）': 'Show purchases (dev)', '沐录里显示 ¥ 按钮；正式包接内购前保持关闭': 'Shows price buttons in Log; keep off until in-app purchase is wired',
  '衔接': 'Transitions', '工作结束自动进休息': 'Auto-start rest after work', '休息结束自动开工': 'Auto-start work after rest',
  '默认关着：防止一段接一段停不下来': 'Off by default so blocks don\'t chain endlessly',
  '休息模式': 'Rest mode', '强制休息': 'Forced rest', '休息期间跳过/回退/重来全部按不动，只剩按住 5 秒的紧急出口': 'During rest, skip / back / restart are locked; only the 5-second emergency hold remains',
  '弹性': 'Flexible', '强制': 'Forced', '最后一段休息可解锁一次': 'Unlock the final rest once', '用掉即失效，下次会话重新给': 'One use per session',
  '声音': 'Sound', '提示音': 'Alerts', '音量': 'Volume', '铃声': 'Chime', '只管 App 开着时的提示音；锁屏后那一声是系统通知发的，音色归系统': 'Only while the app is open; the lock-screen sound is a system notification',
  '清脆': 'Crisp', '钟': 'Bell', '木鱼': 'Wood block', '段末预告': 'Pre-alert', '结束前多少秒先滴一声，0＝不预告': 'Seconds before a block ends to beep; 0 = off', '秒': 's',
  '提醒': 'Reminders', '久坐提醒': 'Stretch reminder', '连续工作多久提醒一次，0＝关': 'Minutes of continuous work before a nudge; 0 = off', '分': 'min',
  '休息结束没反应就一直催': 'Keep nudging if rest ends unanswered',
  '托盘、开机自启、桌宠小窗是桌面端专有的，手机上没有这些概念，所以这里不列。': 'Tray, autostart and the desk pet are desktop-only, so they aren\'t listed here.',
  // 沐录三页
  '读取中…': 'Loading…', '读不到账本：': 'Couldn\'t load ledger: ', '读不到记录：': 'Couldn\'t load records: ',
  '汤札': 'Stamps', '收藏': 'Collection', '庭院': 'Garden', '印': '✓',
  '1 月牌': 'January', '2 月牌': 'February', '3 月牌': 'March', '4 月牌': 'April', '5 月牌': 'May', '6 月牌': 'June', '7 月牌': 'July', '8 月牌': 'August', '9 月牌': 'September', '10 月牌': 'October', '11 月牌': 'November', '12 月牌': 'December', '来了 {n} 天 · 一共来过 {m} 天': '{n} days this month · {m} days in all',
  '累计泡了 {n} 小时 {m} 分 · 可用 {k} 分钟': 'Soaked {n} h {m} min in all · {k} min available',
  '跑完的每一场都会记。中途结束的：满 1 分钟才记（免得误触也留痕），所以拿「调试 · 20 秒 ×2」测的时候，只要没跑完就一条都不会留。': 'Every finished session is logged. Ended early: logged only past 1 minute (so a stray tap leaves no trace).',
  '还没有记录。': 'No records yet.', '{n}月{m}日 ': '{n}/{m} ', '· 专注 {n} 分 · 休息 {m} 分': '· focus {n} min · rest {m} min',
  ' · 中途结束': ' · ended early', ' · 完成': ' · done',
  '挂着': 'Hanging', '点一下挂上': 'Tap to hang', '可以领了': 'Ready to claim', '泡满 {n} 小时': 'Soak {n} h', '泡满 {n} 小时{m} 分': 'Soak {n} h {m} min',
  '累计泡够就能领，顺序固定。已累计 {n} 分钟。': 'Claim each one as your soak time adds up, in a fixed order. {n} min so far.',
  '可用 {n} 分钟（累计 {m}，已用 {k}）': '{n} min available ({m} total, {k} spent)',
  '空着': 'Empty', '摆着': 'Placed', '点一下摆上': 'Tap to place', '{n} 分钟换': '{n} min',
  '可用分钟不够，还差 {n} 分钟': 'Not enough minutes — {n} more needed', '还差 {n} 分钟': '{n} min to go',
  '访客': 'Visitors', '一共来过 {n} 天': '{n} days in all', '常来': 'Regular', '可以请了': 'Can invite', '再来 {n} 天': '{n} more days', '再来 {n} 天它就会来': 'Come {n} more days and it will visit',
  '换来的东西永远是你的；分钟只增不减，不来也不会掉。': 'What you\'ve earned stays yours. Minutes only add up; nothing decays.',
  '已经有了': 'Already owned', '目录里没有这件': 'Not in catalog', '还没有这件': 'Not owned yet', '这件放不到这个位置': 'Doesn\'t fit this spot', '还没有这条': 'Not owned yet', '没有这个位置': 'No such spot',
  // 目录里的名字
  '素帕': 'Plain', '云纹': 'Clouds', '缠枝莲': 'Lotus Vine', '鱼戏': 'Two Fish', '竹影': 'Bamboo', '梅枝': 'Plum', '山水': 'Landscape', '金鳞': 'Gold Scales',
  '风铃': 'Wind Bell', '石灯': 'Stone Lantern', '一盆兰': 'Orchid', '荷花': 'Lotus', '锦鲤': 'Koi', '题壁字': 'Wall Script', '蒲团·青': 'Green Cushion', '茶盘': 'Tea Tray',
  '檐下': 'Under the eaves', '白墙': 'White wall', '石灯旁': 'By the lantern', '石台左侧': 'Left ledge', '近处水面': 'Near water', '常客·阿沐': 'Regular · Mu',
  // 商店（P4）
  '恢复购买': 'Restore purchases', '在这台设备换了 Apple ID 或重装后，把买过的找回来': 'Bring back what you bought after reinstalling or switching Apple ID',
  '已恢复 {n} 项': 'Restored {n} item(s)', '没有可恢复的购买': 'Nothing to restore', '已取消': 'Cancelled', '购买没有完成': 'Purchase didn\'t complete',
  '买下「{s}」，{p}？': 'Buy "{s}" for {p}?', '买下': 'Buy', '买下整套': 'Buy the set', '已拥有': 'Owned', '主题包': 'Theme pack',
  '内测': 'Internal build', '内测：全部解锁': 'Internal: unlock everything', '主题包和本主题全部单件一键拥有，只为看效果；商店包没有这个按钮': 'Own every theme pack and item of this theme at once, for testing only; store builds don\'t have this',
  '全部解锁': 'Unlock all', '已解锁': 'Unlocked', '清除内测解锁': 'Clear internal unlocks', '只撤回内测解锁的，攒来的和真买的原样保留': 'Removes only internal unlocks; earned and purchased items stay', '清除': 'Clear', '已清除': 'Cleared', '不是内测包': 'Not an internal build',
  // 内核拒绝理由
  '现在没有在计时': 'Nothing is running', '现在不是暂停状态': 'Not paused', '现在没有会话': 'No session', '强制休息中，好好歇一会儿': 'Forced rest — take a real break',
  '现在不在段间等待': 'Not between blocks', '序列是空的，先加一段': 'Sequence is empty — add a block', '阶段时长要在 5 秒到 4 小时之间': 'Block length must be 5 s to 4 h',
};

// 编译：纯文本键 → Map；含 {x} 的键 → 正则
const exact = new Map(), tpl = [];
for (const k in D) {
  if (k.indexOf('{') < 0) { exact.set(k, D[k]); continue; }
  const names = [];
  const re = new RegExp('^' + k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '(.+?)'; }) + '$');   // 占位一律宽匹配，捕获片段再递归翻一次（"50 分钟"这类）
  tpl.push({ re, names, out: D[k] });
}
function tr(s) {
  if (!s) return s;
  const t = s.trim(); if (!t) return s;
  const lead = s.slice(0, s.length - s.trimStart().length), tail = s.slice(s.trimEnd().length);
  if (exact.has(t)) return lead + exact.get(t) + tail;
  for (const { re, names, out } of tpl) {
    const m = t.match(re);
    if (m) { let o = out; names.forEach((n, i) => { o = o.replace('{' + n + '}', tr(m[i + 1])); }); return lead + o + tail; }
  }
  // 句中片段：把能整句匹配的中文子串逐个替换（处理"xx · yy"拼接）
  if (/[一-鿿]/.test(t)) {
    const parts = t.split(/( · |：|、)/);
    if (parts.length > 1) { const r = parts.map(p => (p === ' · ' || p === '：' || p === '、') ? p : tr(p)).join(''); if (r !== t) return lead + r + tail; }
  }
  return s;
}

const I18N = window.I18N = {
  lang, t: (s) => lang === 'en' ? tr(s) : s,
  set(l) { try { localStorage.setItem('capy_lang', l); } catch (e) {} location.reload(); },
  apply(root) { if (lang !== 'en') return; walk(root || document.body); },
};
function walk(node) {
  if (node.nodeType === 3) { const v = tr(node.nodeValue); if (v !== node.nodeValue) node.nodeValue = v; return; }
  if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
  if (node.placeholder) { const v = tr(node.placeholder); if (v !== node.placeholder) node.placeholder = v; }
  for (const c of node.childNodes) walk(c);
}
if (lang === 'en') {
  document.documentElement.lang = 'en';
  const run = () => { walk(document.body); };
  if (document.body) run(); else document.addEventListener('DOMContentLoaded', run);
  const mo = new MutationObserver((muts) => {
    mo.disconnect();
    for (const m of muts) {
      if (m.type === 'characterData') walk(m.target);
      else m.addedNodes.forEach(walk);
    }
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true, characterData: true }));
  if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true });
}
})();
