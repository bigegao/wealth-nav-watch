#!/usr/bin/env bash
#
# 把这套东西装到 bigegao/wealth-nav-watch 的一个新分支上。
#
# 用法（在**你对目标仓库有写权限**的机器上）：
#
#     bash install.sh
#     bash install.sh git@github.com:bigegao/wealth-nav-watch.git
#
# 做完会打印一个链接，点开就是开好的 PR 页面。
#
# 前提：你的 Git 凭据能推目标仓库（SSH key 或带写权限的 token）。
set -euo pipefail

REPO_URL="${1:-git@github.com:bigegao/wealth-nav-watch.git}"
BRANCH="${BRANCH:-feat/daily-nav-sync}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ 克隆 $REPO_URL"
git clone "$REPO_URL" "$WORK/repo"
cd "$WORK/repo"

git checkout -b "$BRANCH"

echo "→ 写入 workflow / 脚本 / 样例"
mkdir -p .github/workflows scripts samples
cp -R "$HERE/.github/workflows/." .github/workflows/
cp "$HERE/scripts/"* scripts/
cp "$HERE/samples/"* samples/
cp "$HERE/README.md" .
[ -f "$HERE/.gitignore" ] && cp "$HERE/.gitignore" . || true

git add -A
git -c user.name="${GIT_AUTHOR_NAME:-Mavis}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-mavis@local}" \
    commit -q -m "feat: 中行净值每日增量 workflow + 抓取脚本

抓中国银行「当日代销理财产品净值」静态页，只把新增的
(来源, 产品代码, 净值日期) 组合存成 CSV 推进仓库：
data/YYYY-MM-DD.csv，文件名是运行日期（北京时间）。

- workflow：每天北京 20:20 跑，permissions: contents: write，
  认证不落盘到 .git/config，推送失败自动 rebase 重试
- 脚本：零第三方依赖，去重键 (source_dir, code, nav_date) 不含 run_date，
  抓取失败抛错，没有新增不写文件"

echo "→ 推送分支 $BRANCH"
git push -u origin "$BRANCH"

BASE_URL="${REPO_URL%.git}"
BASE_URL="${BASE_URL/git@github.com:/https:\/\/github.com\/}"
echo
echo "✅ 推完了。开 PR 的链接（点开就是填好的表单）："
echo "   ${BASE_URL}/compare/main...${BRANCH}?expand=1"
echo
echo "开完后 workflow 会在每天北京时间 20:20 自动跑。"
echo "注意：schedule 与手动触发都要求 workflow 文件在**默认分支**上 —— 合并到 main 之后才会生效。"
