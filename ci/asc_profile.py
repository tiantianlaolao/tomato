#!/usr/bin/env python3
"""用 App Store Connect API 建（或取回）capyroom 的 Ad-Hoc Provisioning Profile。

为什么要自己建：`tauri ios build` **不会把 `-- <ARGS>` 转给 xcodebuild**
（8-28 实测：透传版和不透传版报的错一模一样），所以 `-allowProvisioningUpdates`
进不去，Xcode 自动创建 Profile 这条路走不通。于是改成：
  Tauri 只负责编译（--no-sign --archive-only，已验证可跑）→ 我们自己建 Profile、
  自己 codesign、自己打 IPA。每一步都是确定的，没有"参数转不转"这种赌博。

🔴 没有任何凭据写死在文件里：全部从环境变量读
   ASC_KEY_ID / ASC_ISSUER_ID / ASC_API_KEY_BASE64（CI 里是 GitHub Secrets）。
   本机跑可以改用 ASC_API_KEY_PATH 指向 .p8。
⚠️ 不叫 _deploy_*.py：仓里 .gitignore 把那个前缀整个挡掉，会静默不进仓。

用法：python ci/asc_profile.py <bundle_id> <输出.mobileprovision>
"""
import base64, json, os, sys, time, urllib.request, urllib.error

import jwt  # PyJWT

API = "https://api.appstoreconnect.apple.com"
BUNDLE_ID = sys.argv[1] if len(sys.argv) > 1 else "com.tybbtech.capyroom"
OUT = sys.argv[2] if len(sys.argv) > 2 else "capyroom.mobileprovision"
PROFILE_NAME = "capyroom AdHoc CI"


def load_key():
    b64 = os.environ.get("ASC_API_KEY_BASE64")
    if b64:
        return base64.b64decode(b64)
    path = os.environ.get("ASC_API_KEY_PATH")
    if path:
        return open(path, "rb").read()
    sys.exit("缺 ASC_API_KEY_BASE64 或 ASC_API_KEY_PATH")


KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER_ID = os.environ["ASC_ISSUER_ID"]
now = int(time.time())
TOKEN = jwt.encode(
    {"iss": ISSUER_ID, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
    load_key(), algorithm="ES256", headers={"alg": "ES256", "kid": KEY_ID, "typ": "JWT"})


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        "Authorization": "Bearer " + TOKEN,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw.decode(errors="replace")[:400]}


def die(msg, body=None):
    print("❌ " + msg)
    if body is not None:
        print(json.dumps(body, indent=2)[:1200])
    sys.exit(1)


# ── ① Bundle ID：没有就建 ──────────────────────────────
code, b = call("GET", f"/v1/bundleIds?filter[identifier]={BUNDLE_ID}&limit=200")
if code != 200:
    die(f"查 bundleIds 失败 HTTP {code}", b)
hit = [d for d in b.get("data", []) if d["attributes"]["identifier"] == BUNDLE_ID]
if hit:
    bundle_uid = hit[0]["id"]
    print(f"① Bundle ID 已存在：{BUNDLE_ID}")
else:
    code, b = call("POST", "/v1/bundleIds", {"data": {
        "type": "bundleIds",
        "attributes": {"identifier": BUNDLE_ID, "name": "capyroom", "platform": "IOS"},
    }})
    if code not in (200, 201):
        die(f"建 bundleId 失败 HTTP {code}", b)
    bundle_uid = b["data"]["id"]
    print(f"① Bundle ID 新建：{BUNDLE_ID}")

# ── ② 分发证书 ───────────────────────────────────────
code, b = call("GET", "/v1/certificates?limit=200")
if code != 200:
    die(f"查 certificates 失败 HTTP {code}", b)
certs = [d for d in b.get("data", [])
         if d["attributes"].get("certificateType") in ("DISTRIBUTION", "IOS_DISTRIBUTION")]
if not certs:
    die("账号里没有可用的分发证书")
cert_ids = [c["id"] for c in certs]
print(f"② 分发证书 {len(certs)} 张：" +
      ", ".join(c["attributes"].get("name", "?")[:40] for c in certs))

# ── ③ 已注册设备（Ad-Hoc 只能装进这些机器）─────────────────
code, b = call("GET", "/v1/devices?filter[status]=ENABLED&limit=200")
if code != 200:
    die(f"查 devices 失败 HTTP {code}", b)
devs = [d for d in b.get("data", []) if d["attributes"].get("platform") == "IOS"]
if not devs:
    die("账号里没有已注册的 iOS 设备 —— Ad-Hoc 包装不进任何机器")
dev_ids = [d["id"] for d in devs]
print(f"③ 已注册 iOS 设备 {len(devs)} 台：" +
      ", ".join(d["attributes"].get("name", "?")[:20] for d in devs[:6]))

# ── ④ 旧 Profile 先删 ────────────────────────────────
# 🔴 必须删了重建，不能复用：Profile 里的设备列表是**建的那一刻固化**的，
#    以后新加的设备不会自动进去，直接复用会出现"新手机装不上"的怪事。
code, b = call("GET", "/v1/profiles?limit=200")
if code == 200:
    for d in b.get("data", []):
        if d["attributes"].get("name") == PROFILE_NAME:
            c2, _ = call("DELETE", f"/v1/profiles/{d['id']}")
            print(f"④ 删掉同名旧 Profile（HTTP {c2}）")

# ── ⑤ 建 Ad-Hoc Profile ──────────────────────────────
code, b = call("POST", "/v1/profiles", {"data": {
    "type": "profiles",
    "attributes": {"name": PROFILE_NAME, "profileType": "IOS_APP_ADHOC"},
    "relationships": {
        "bundleId": {"data": {"type": "bundleIds", "id": bundle_uid}},
        "certificates": {"data": [{"type": "certificates", "id": i} for i in cert_ids]},
        "devices": {"data": [{"type": "devices", "id": i} for i in dev_ids]},
    },
}})
if code not in (200, 201):
    die(f"建 Profile 失败 HTTP {code}", b)

content = b["data"]["attributes"]["profileContent"]
raw = base64.b64decode(content)
with open(OUT, "wb") as f:
    f.write(raw)
print(f"⑤ Profile 已写出：{OUT}  {len(raw)} 字节")
print(f"   UUID = {b['data']['attributes'].get('uuid')}")
print(f"   名称 = {PROFILE_NAME}")
