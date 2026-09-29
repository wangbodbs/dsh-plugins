#!/usr/bin/env python3
"""把 submission/ 里的条目提交到 awesome-dsh-plugin 目录。

做三件事，分两步走（因为 CI 有「被收录仓库须创建满 1 天」的硬门槛）：

    python3 scripts/open-catalog-pr.py            # 准备：建 fork、把条目推到一个分支
    python3 scripts/open-catalog-pr.py --pr       # 隔一天再跑，真正开 PR

    python3 scripts/open-catalog-pr.py --status   # 只看当前进度

Token：读环境变量 GITHUB_TOKEN，没有就读 ~/.dsh/.github-token（文件不落在本仓库里）。
需要 classic PAT 的 public_repo 权限（对上游公开仓库 fork / 提 PR）。
"""

import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin"
BRANCH = "add-wangbodbs-dsh-plugins"
REPO_DIR = pathlib.Path(__file__).resolve().parent.parent
SUBMISSION = REPO_DIR / "submission"
API = "https://api.github.com"

PR_TITLE = "Add three plugins: dsh-feishu, dsh-mcp-flapi, dsh-mcp-davinci-resolve"
PR_BODY = """\
All three live in the same monorepo, `wangbodbs/dsh-plugins`, as separately
installable subpackages under `packages/` — one entry per subdirectory.

- `packages/dsh-feishu` — a Feishu / Lark chat channel for DSH (`notify`). Each
  chat maps to a DSH session; messages become turns and answers are pushed back
  as cards. It ships three tools (`feishu_send`, `feishu_ask`,
  `feishu_drive_pull`) and slash commands for permission mode, model selection,
  and conversation generations. No runtime dependencies.
- `packages/dsh-mcp-flapi` — registers FilmLight's official FLAPI MCP assistant
  (`flapi-dev-mcp`) as an MCP server in DSH (`tools`).
- `packages/dsh-mcp-davinci-resolve` — registers the MCP server built into
  DaVinci Resolve 21.1+ as an MCP server in DSH (`tools`).

Verified before submitting: each subpackage installs on its own from this
repository with the subdirectory selector, into a clean profile —

    dsh plugin --profile probe add \\
      "git+https://github.com/wangbodbs/dsh-plugins.git#path:/packages/dsh-feishu"

— which resolves and composes without a build step (`dsh --profile probe
--dump-config` exits 0 with all three rows in the tree).
"""


def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)


def token():
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if t:
        return t
    p = pathlib.Path.home() / ".dsh" / ".github-token"
    if p.exists():
        return p.read_text().strip()
    die("拿不到 token：设 GITHUB_TOKEN，或写 ~/.dsh/.github-token")


def api(method, path, body=None, tok=None, raw=False):
    url = path if path.startswith("http") else f"{API}{path}"
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"token {tok}")
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = r.read()
            return (r.status, payload if raw else (json.loads(payload) if payload else None))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except Exception:
            return e.code, {"message": payload.decode(errors="replace")[:400]}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--prepare"
    tok = token()

    code, me = api("GET", "/user", tok=tok)
    if code != 200:
        die(f"token 无效：{me}")
    owner = me["login"]

    code, up = api("GET", f"/repos/{UPSTREAM}", tok=tok)
    if code != 200:
        die(f"读不到上游仓库：{up}")
    default_branch = up["default_branch"]

    entries = sorted(SUBMISSION.glob("*.yml"))
    if not entries:
        die(f"{SUBMISSION} 里没有条目文件")

    code, repo = api("GET", f"/repos/{owner}/dsh-plugins", tok=tok)
    if code != 200:
        die("读不到 wangbodbs/dsh-plugins")
    created = repo["created_at"]

    # 仓库年龄：CI 的硬门槛
    from datetime import datetime, timezone

    born = datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    age_s = (datetime.now(timezone.utc) - born).total_seconds()
    ok_age = age_s >= 86400
    print(f"被收录仓库 wangbodbs/dsh-plugins 创建于 {created}")
    print(f"  年龄 {age_s/3600:.1f} 小时 → 1 天门槛 {'✅ 已过' if ok_age else '⏳ 还没到'}")
    print(f"上游默认分支 {UPSTREAM}@{default_branch}")
    print(f"要提交 {len(entries)} 条：" + ", ".join(e.name for e in entries))

    if mode == "--status":
        code, prs = api("GET", f"/repos/{UPSTREAM}/pulls?head={owner}:{BRANCH}&state=all", tok=tok)
        print(f"已有 PR：{[(p['number'], p['state'], p['html_url']) for p in prs] if code == 200 else prs}")
        return

    # 1) fork（幂等）
    code, fork = api("GET", f"/repos/{owner}/{UPSTREAM.split('/')[1]}", tok=tok)
    if code == 404:
        print("→ 建 fork…")
        code, fork = api("POST", f"/repos/{UPSTREAM}/forks", {}, tok=tok)
        if code not in (202, 201):
            die(f"fork 失败：{fork}")
        for _ in range(30):
            time.sleep(3)
            code, fork = api("GET", f"/repos/{owner}/{UPSTREAM.split('/')[1]}", tok=tok)
            if code == 200:
                break
        if code != 200:
            die("fork 建好了但一直读不到")
    elif code != 200:
        die(f"查 fork 失败：{fork}")
    print(f"→ fork 就绪：{fork['full_name']}")

    fork_base = fork["default_branch"]

    # 2) 在 fork 上建一个提交，带三个条目文件
    code, ref = api("GET", f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/ref/heads/{fork_base}", tok=tok)
    if code != 200:
        die(f"读 fork 分支失败：{ref}")
    base_sha = ref["object"]["sha"]

    tree = []
    for f in entries:
        code, blob = api(
            "POST",
            f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/blobs",
            {"content": base64.b64encode(f.read_bytes()).decode(), "encoding": "base64"},
            tok=tok,
        )
        if code != 201:
            die(f"建 blob 失败（{f.name}）：{blob}")
        tree.append({"path": f"data/plugins/{f.name}", "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print(f"   + data/plugins/{f.name}")

    code, commit = api("GET", f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/commits/{base_sha}", tok=tok)
    if code != 200:
        die(f"读 base commit 失败：{commit}")
    code, new_tree = api(
        "POST",
        f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/trees",
        {"base_tree": commit["tree"]["sha"], "tree": tree},
        tok=tok,
    )
    if code != 201:
        die(f"建 tree 失败：{new_tree}")

    msg = "Add three plugins from wangbodbs/dsh-plugins\n\n" + "\n".join(
        f"- {f.stem.replace('__', '/').replace('--', '/')}" for f in entries
    )
    code, new_commit = api(
        "POST",
        f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/commits",
        {"message": msg, "tree": new_tree["sha"], "parents": [base_sha]},
        tok=tok,
    )
    if code != 201:
        die(f"建 commit 失败：{new_commit}")

    code, existing = api("GET", f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/ref/heads/{BRANCH}", tok=tok)
    if code == 200:
        code, res = api(
            "PATCH",
            f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/refs/heads/{BRANCH}",
            {"sha": new_commit["sha"], "force": True},
            tok=tok,
        )
        action = "更新"
    else:
        code, res = api(
            "POST",
            f"/repos/{owner}/{UPSTREAM.split('/')[1]}/git/refs",
            {"ref": f"refs/heads/{BRANCH}", "sha": new_commit["sha"]},
            tok=tok,
        )
        action = "创建"
    if code not in (200, 201):
        die(f"{action}分支失败：{res}")
    print(f"→ 分支已{action}：{fork['full_name']}:{BRANCH} @ {new_commit['sha'][:8]}")

    if mode != "--pr":
        print("\n就绪。等被收录仓库满 24 小时后跑：  python3 scripts/open-catalog-pr.py --pr")
        return

    if not ok_age:
        die(f"仓库才 {age_s/3600:.1f} 小时，不到 1 天。早了 CI 一定红，明天再来。")

    code, prs = api("GET", f"/repos/{UPSTREAM}/pulls?head={owner}:{BRANCH}&state=open", tok=tok)
    if code == 200 and prs:
        print(f"✅ 已有开着的 PR：{prs[0]['html_url']}")
        return

    code, pr = api(
        "POST",
        f"/repos/{UPSTREAM}/pulls",
        {"title": PR_TITLE, "head": f"{owner}:{BRANCH}", "base": default_branch, "body": PR_BODY},
        tok=tok,
    )
    if code != 201:
        die(f"开 PR 失败：{pr}")
    print(f"\n✅ PR 已开：{pr['html_url']}")


if __name__ == "__main__":
    main()
