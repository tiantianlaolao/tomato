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
STAGE = "/tmp/capyroom_ota"          # 🔴 用 /tmp 不用 ~：sudo bash -c 里的 ~ 会变成 root 的家目录
FILES = sys.argv[1:]
if not FILES:
    sys.exit("没有要传的文件")


def run(ssh, cmd, sudo=False):
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


ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, PORT, USER, PWD, timeout=25)

run(ssh, f"rm -rf {STAGE} && mkdir -p {STAGE}")

# 🔴 大文件传输走原生 scp，不用 paramiko SFTP——
#    paramiko 单流小窗口在中美高延迟链路上只有 ~8KB/s（35MB 传了 50 分钟，8-30 实测），
#    OpenSSH scp 大窗口对延迟不敏感，同一条线快一个数量级（agentos-ios 同款做法）。
#    sshpass 现装（脚本内装，不动 workflow 文件）。
import subprocess, shutil, time
if not shutil.which("sshpass"):
    subprocess.run(["brew", "install", "hudochenkov/sshpass/sshpass"], check=True)
t0 = time.time()
subprocess.run(
    ["sshpass", "-p", PWD, "scp", "-o", "StrictHostKeyChecking=no", "-P", str(PORT)]
    + FILES + [f"{USER}@{HOST}:{STAGE}/"],
    check=True)
tot = sum(os.path.getsize(f) for f in FILES)
dt = max(1, time.time() - t0)
print(f"  scp 传完 {len(FILES)} 个文件 {tot//1024}KB，{dt:.0f}s（{tot/1024/dt:.0f}KB/s）")

# 只覆盖同名文件，不清空目录
run(ssh, f"mkdir -p {LIVE} && cp -a {STAGE}/. {LIVE}/ "
         f"&& chown -R www-data:www-data {LIVE} && chmod -R a+rX {LIVE} && rm -rf {STAGE}", sudo=True)
print("落位完成：\n" + run(ssh, f"ls -l {LIVE}"))
ssh.close()
