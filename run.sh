#!/bin/bash
# 공동구매 대시보드 자동 갱신 — NCP 서버 cron 이 매시 실행한다.
# 흔적을 반드시 남긴다(run.log). 로그가 없으면 멈춰도 아무도 모른다.
set -o pipefail
cd /root/groupbuy-live || exit 1
LOG=/root/groupbuy-live/run.log

echo "[$(date '+%F %T')] === 시작 ===" >> "$LOG"

if ! /usr/bin/node --env-file=/root/sales-order-sync/.env scripts/sync.mjs >> "$LOG" 2>&1; then
  echo "❌ 주문 수집 실패 — 배포 중단" >> "$LOG"
  echo "[$(date '+%F %T')] === 종료(실패) ===" >> "$LOG"
  echo "----" >> "$LOG"
  exit 1
fi

if [ -n "$(git status --porcelain data)" ]; then
  git add data
  git -c user.name="groupbuy bot" -c user.email="bot@users.noreply.github.com" \
      commit -qm "data: $(date '+%F %H:%M') 자동 갱신"

  # 맥에서 코드를 고쳐 올리면 원격이 앞서 있어 푸시가 막힌다.
  # 그대로 두면 화면 숫자가 조용히 얼어붙으므로, 한 번 합쳐보고 다시 민다.
  if git push -q origin main >> "$LOG" 2>&1; then
    echo "✅ 배포 푸시 완료" >> "$LOG"
  elif git pull --rebase -q >> "$LOG" 2>&1 && git push -q origin main >> "$LOG" 2>&1; then
    echo "✅ 배포 푸시 완료 (원격 변경분 합친 뒤)" >> "$LOG"
  else
    git rebase --abort 2>/dev/null
    echo "❌ 푸시 실패 — 화면이 옛날 숫자로 남는다. 사람이 봐야 함" >> "$LOG"
  fi
else
  echo "변경 없음" >> "$LOG"
fi

echo "[$(date '+%F %T')] === 종료 ===" >> "$LOG"
echo "----" >> "$LOG"
