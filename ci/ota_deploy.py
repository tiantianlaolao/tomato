#!/usr/bin/env python3
"""把 capyroom 的 Ad-Hoc 测试包放到 /var/www/capyroom/_t/。

🔴 这个文件里没有任何凭据，全部从环境变量读（CI 里是 GitHub Secrets）。
⚠️ **不叫 `_deploy_*.py`**：仓里的 .gitignore 把那个前缀整个挡掉了，
   叫那个名字会静默不进仓 —— 这个坑在别的项目上踩过。

落点 `/var/www/capyroom/_t/` 的 nginx location 是 8-28 加的（备份在
/home/ubuntu/nginx-backup/），HTTPS 现成 —— itms-services 装机必须 HTTPS。
"""
import os, sys, posixpath, paramiko

HOST = os.environ["OTA_SSH_HOST"]
PORT = int(os.environ.get("OTA_SSH_PORT", "22"))
USER = os.environ["OTA_SSH_USER"]
PWD  = os.environ["OTA_SSH_PASSWORD"]

LIVE  = "/var/www/capyroom/_t"
# 🔴 用 /tmp 不用 ~：sudo bash -c 里的 ~ 会变成 root 的家目录
# 🔴 暂存目录必须每次唯一（9-5）：测试线和 Play 线同时出包，共用 /tmp/capyroom_ota 时后进来的 rm -rf 把前一个正在拼的分块删了
#    （"cat …part*: No such file"）。带上 run id，本地跑就带 pid。
STAGE = "/tmp/capyroom_ota_" + os.environ.get("GITHUB_RUN_ID", str(os.getpid()))
FILES = sys.argv[1:]
if not FILES:
    sys.exit("没有要传的文件")


def connect():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, PORT, USER, PWD, timeout=25)
    c.get_transport().set_keepalive(20)   # 🔴 并行 scp 那几分钟控制连接是闲的，不发 keepalive 会被踢（9-5 Play 线 24MB 包实证）
    return c


def run(_ssh, cmd, sudo=False):
    global ssh
    tr = ssh.get_transport()
    if tr is None or not tr.is_active():
        print("  SSH 会话已断（长传输期间被踢），重连一次")
        ssh = connect()
    if sudo:
        cmd = "sudo -S -p '' bash -c " + "'" + cmd.replace("'", "'\"'\"'") + "'"
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=180)
    if sudo:
        stdin.write(PWD + "\n"); stdin.flush()
    rc = stdout.channel.recv_exit_status()
    out, err = stdout.read().decode(errors="replace"), stderr.read().decode(errors="replace")
    if rc != 0:
        sys.exit(f"远端命令失败 rc={rc}\n{cmd[:80]}\n{err[:400]}")
    return out


ssh = connect()

run(ssh, f"rm -rf {STAGE} && mkdir -p {STAGE}")

# 🔴 大文件传输＝并行分流 scp（8-30 实测：这条 runner→国内链路单流只有 ~8KB/s，
#    paramiko 和原生 scp 一个样——瓶颈是链路每条 TCP 流的份额，不是工具。
#    档案实测并行 8 流提速 ~6 倍：切 4MB 块、十条 scp 并发、远端 cat 拼回）。
import subprocess, shutil, time, tempfile
if not shutil.which("sshpass"):
    subprocess.run(["brew", "install", "hudochenkov/sshpass/sshpass"], check=True)

CHUNK = 4 * 1024 * 1024
MAXP = 10
SCP = ["sshpass", "-p", PWD, "scp", "-o", "StrictHostKeyChecking=no", "-P", str(PORT)]

t0 = time.time()
tmpd = tempfile.mkdtemp()
uploads = []          # (本地路径, 远端文件名)
assembles = []        # (目标名, 块数)
for f in FILES:
    name = os.path.basename(f)
    size = os.path.getsize(f)
    if size <= CHUNK:
        uploads.append((f, name))
        continue
    with open(f, "rb") as src:
        i = 0
        while True:
            buf = src.read(CHUNK)
            if not buf:
                break
            p = os.path.join(tmpd, f"{name}.part{i:03d}")
            with open(p, "wb") as w:
                w.write(buf)
            uploads.append((p, os.path.basename(p)))
            i += 1
    assembles.append((name, i))

# 🔴 并发认证会被 sshd 打掉个别连接（8-30 实测：10 条齐撞，1 条
#    Permission denied——密码是对的，paramiko 同密码已连上）。
#    所以：起步错开 0.6s + 失败的块单独重试，绝不因一条判死整批。
def upload_batch(batch):
    procs = []
    for local, remote in batch:
        while len([p for p in procs if p[0].poll() is None]) >= MAXP:
            time.sleep(0.3)
        procs.append((subprocess.Popen(SCP + [local, f"{USER}@{HOST}:{STAGE}/{remote}"]),
                      local, remote))
        time.sleep(0.6)
    return [(l, r) for p, l, r in procs if p.wait() != 0]

pending = uploads
for attempt in range(4):
    if not pending:
        break
    if attempt:
        print(f"  第{attempt}次重试 {len(pending)} 块")
        time.sleep(5)
    pending = upload_batch(pending)
if pending:
    sys.exit(f"重试后仍有 {len(pending)} 块传不上去：{[r for _, r in pending]}")
for name, n in assembles:
    run(ssh, f"cat {STAGE}/{name}.part* > {STAGE}/{name} && rm {STAGE}/{name}.part*")
    print(f"  远端拼回 {name}（{n} 块）")
tot = sum(os.path.getsize(f) for f in FILES)
dt = max(1, time.time() - t0)
print(f"  并行 scp 传完 {tot//1024}KB，{dt:.0f}s（{tot/1024/dt:.0f}KB/s，{len(uploads)} 块 ×{MAXP} 并发）")

# 只覆盖同名文件，不清空目录
run(ssh, f"mkdir -p {LIVE} && cp -a {STAGE}/. {LIVE}/ "
         f"&& chown -R www-data:www-data {LIVE} && chmod -R a+rX {LIVE} && rm -rf {STAGE}", sudo=True)
print("落位完成：\n" + run(ssh, f"ls -l {LIVE}"))
ssh.close()
