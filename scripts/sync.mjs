// 공동구매 파트너 대시보드 — 네이버 주문 수집기
//
// 어디서 도나: NCP 서버 /root/groupbuy-live (고정 IP 49.50.128.134 만 커머스API 허용)
// 무엇을 하나: partners.json 의 상품번호에 해당하는 주문만 골라 data/<token>.json 을 만든다.
//              그 뒤 run.sh 가 깃허브로 밀어 올리면 Pages 페이지가 갱신된다.
//
// 재고/발주 파이프라인(sales-order-sync)과 파일도 캐시도 완전히 분리돼 있다.
// 기존 파트너 시스템(affiliate-dashboard·구글시트)과도 무관하다.
//
// 실행
//   node --env-file=/root/sales-order-sync/.env scripts/sync.mjs          // 최근 48시간
//   FULL=1 node --env-file=... scripts/sync.mjs                           // 오픈일부터 전체 재수집
//   DRY=1  node --env-file=... scripts/sync.mjs                           // 파일 안 쓰고 출력만

import bcrypt from "bcryptjs";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first"); // 네이버는 IPv4 만 화이트리스트

const BASE = "https://api.commerce.naver.com/external";
const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const DRY = !!process.env.DRY;
const FULL = !!process.env.FULL;
const CACHE_DIR = process.env.CACHE_DIR || "/root/.groupbuy-cache";

// 매출·건수에 포함할 상태 (취소/반품/미결제 제외)
const COUNTED = new Set(["PAYED", "DELIVERING", "DELIVERED", "PURCHASE_DECIDED", "EXCHANGED"]);
const LABEL = {
  PAYED: "결제완료", DELIVERING: "배송중", DELIVERED: "배송완료",
  PURCHASE_DECIDED: "구매확정", EXCHANGED: "교환",
  CANCELED: "취소", RETURNED: "반품",
  PAYMENT_WAITING: "입금대기", CANCELED_BY_NOPAYMENT: "미입금취소",
};

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("❌ NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 없음");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace("Z", "+09:00");
const kst = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

// ─────────────────────────────────────────────── 네이버 API

async function getToken() {
  const ts = Date.now();
  const sign = Buffer.from(bcrypt.hashSync(`${CLIENT_ID}_${ts}`, CLIENT_SECRET), "utf-8")
    .toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, timestamp: String(ts),
      grant_type: "client_credentials", client_secret_sign: sign, type: "SELF",
    }),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패 ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function api(token, path, opts = {}, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error(`재시도 초과: ${path}`);
}

/** 기간 내 변경된 상품주문 ID (API 제한: 한 번에 24시간까지) */
async function changedIds(token, from, to) {
  const ids = new Set();
  for (let cur = new Date(from); cur < to;) {
    const end = new Date(Math.min(cur.getTime() + 24 * 3600e3 - 1000, to.getTime()));
    let more = null, page = 0;
    do {
      const q = new URLSearchParams({ lastChangedFrom: iso(cur), lastChangedTo: iso(end) });
      if (more) q.set("moreSequence", more);
      const j = await api(token, `/v1/pay-order/seller/product-orders/last-changed-statuses?${q}`);
      for (const x of j?.data?.lastChangeStatuses || []) {
        if (x.productOrderId) ids.add(String(x.productOrderId));
      }
      more = j?.data?.more?.moreSequence || null;
      await sleep(300);
    } while (more && ++page < 20);
    cur = new Date(end.getTime() + 1000);
  }
  return [...ids];
}

async function details(token, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 300) {
    const j = await api(token, "/v1/pay-order/seller/product-orders/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productOrderIds: ids.slice(i, i + 300) }),
    });
    out.push(...(j?.data || []));
    await sleep(300);
  }
  return out;
}

// ─────────────────────────────────────────────── 변환

/** 화면에 내보내는 필드만 남긴다. 받는분·주소·연락처 등 개인정보는 절대 담지 않는다.
 *  (이 저장소는 Pages 를 쓰기 위해 공개 저장소다) */
function mapOrder(item) {
  const po = item.productOrder || {}, o = item.order || {};
  const dt = o.orderDate || po.placeOrderDate || "";
  return {
    id: String(po.productOrderId || ""),
    productId: String(po.productId || ""),
    originalProductId: String(po.originalProductId || ""),
    date: dt.slice(0, 10),
    datetime: dt,
    product: po.productName || "",
    option: po.productOption || "",
    qty: po.quantity || 1,
    amount: po.totalPaymentAmount ?? po.totalProductAmount ?? 0,
    code: po.productOrderStatus || "",
  };
}

function buildPayload(p, orders, now) {
  const sorted = orders.slice().sort((a, b) => (b.datetime || "").localeCompare(a.datetime || ""));
  const counted = sorted.filter((o) => COUNTED.has(o.code));

  const byDate = new Map();
  for (const o of counted) {
    const cur = byDate.get(o.date) || { date: o.date, count: 0, qty: 0, revenue: 0 };
    cur.count += 1; cur.qty += o.qty || 1; cur.revenue += o.amount || 0;
    byDate.set(o.date, cur);
  }

  return {
    partner: p.partner,
    openDate: p.openDate || "",
    endDate: p.endDate || "",
    commissionRate: p.commissionRate ?? 15,
    buyUrl: p.buyUrl || "",
    updatedAt: kst(now),
    summary: {
      count: counted.length,
      qty: counted.reduce((s, o) => s + (o.qty || 1), 0),
      revenue: counted.reduce((s, o) => s + (o.amount || 0), 0),
    },
    daily: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    orders: sorted.map((o) => ({
      date: o.date,
      product: o.product,
      option: o.option,
      qty: o.qty,
      amount: o.amount,
      status: LABEL[o.code] || o.code,
    })),
  };
}

// ─────────────────────────────────────────────── 메인

async function main() {
  const partners = JSON.parse(readFileSync("partners.json", "utf-8"));
  const wanted = new Map(); // 상품번호 -> 파트너
  for (const p of partners) for (const id of p.productIds) wanted.set(String(id), p);

  const now = new Date();
  const earliest = partners
    .map((p) => p.openDate).filter(Boolean).sort()[0] || "2026-01-01";
  const from = FULL
    ? new Date(`${earliest}T00:00:00+09:00`)
    : new Date(now.getTime() - 48 * 3600e3);

  console.log(`파트너 ${partners.length}명 / 상품번호 ${wanted.size}개`);
  console.log(`조회 구간: ${iso(from).slice(0, 10)} ~ ${iso(now).slice(0, 10)}${FULL ? " (전체 재수집)" : ""}`);

  const token = await getToken();
  const ids = await changedIds(token, from, now);
  const items = ids.length ? await details(token, ids) : [];
  const fresh = items.map(mapOrder)
    .filter((o) => wanted.has(o.productId) || wanted.has(o.originalProductId));
  console.log(`변경 주문 ${ids.length}건 중 공동구매 ${fresh.length}건`);

  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync("data")) mkdirSync("data");

  for (const p of partners) {
    const cacheFile = `${CACHE_DIR}/${p.token}.json`;
    let cached = [];
    if (existsSync(cacheFile) && !FULL) {
      try { cached = JSON.parse(readFileSync(cacheFile, "utf-8")).orders || []; } catch {}
    }
    const mine = fresh.filter((o) =>
      (wanted.get(o.productId) || wanted.get(o.originalProductId)) === p);

    const byId = new Map(cached.map((o) => [o.id, o]));
    for (const o of mine) byId.set(o.id, o); // 같은 주문의 최신 상태로 덮어쓴다
    const all = [...byId.values()];

    const payload = buildPayload(p, all, now);
    console.log(`  ${p.partner}: ${payload.summary.count}건 / ${payload.summary.qty}개 / ${payload.summary.revenue.toLocaleString()}원`);

    if (DRY) continue;
    writeFileSync(cacheFile, JSON.stringify({ updatedAt: now.toISOString(), orders: all }, null, 1));
    writeFileSync(`data/${p.token}.json`, JSON.stringify(payload, null, 1));
  }

  if (DRY) console.log("[DRY] 파일 안 씀");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
