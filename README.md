# groupbuy-live — 공동구매 파트너 실시간 대시보드

공동구매 파트너에게 **본인 판매 실적만** 보여주는 전용 페이지.
첫 파트너: **꾸노핑** (2026-08-12 오픈, 수수료 15%)

## 왜 따로 있나

기존 파트너 대시보드(`darimati/affiliate-dashboard`)는 여러 파트너의 구글시트·정산이 얽혀 있고,
우리 계정에는 **읽기 권한밖에 없다.** 공동구매는 성격도 다르고(정산 방식·기간·상품) 사고 위험도 커서
**디자인만 가져오고 데이터 연결은 완전히 분리**했다.

## 흐름

```
네이버 스마트스토어 주문
  └─ NCP 서버(49.50.128.134) cron 매시
       └─ scripts/sync.mjs   상품번호로 공동구매 건만 필터
            └─ data/<token>.json  생성
                 └─ git push → GitHub Pages 자동 배포
                      └─ index.html?t=<token>  파트너가 보는 화면
```

- 네이버 커머스 API 는 **고정 IP 화이트리스트**라 깃허브 액션에서는 호출이 불가능하다. 반드시 NCP 서버에서 돈다.
- 네이버 인증키는 이 저장소에 없다. 서버의 `/root/sales-order-sync/.env` 를 그대로 빌려 쓴다.

## 파트너 추가하는 법

`partners.json` 에 한 줄 추가하고 푸시하면 끝. 코드는 안 건드린다.

```json
{
  "token": "무작위 22자",              // 페이지 주소이자 열쇠. openssl rand -base64 18 | tr -d '/+=' | head -c 22
  "partner": "파트너명",
  "productIds": ["스마트스토어 상품번호"],  // 판매링크 .../products/{번호}
  "commissionRate": 15,
  "openDate": "2026-08-12",
  "buyUrl": "https://brand.naver.com/darimati/products/..."
}
```

그다음 서버에서 한 번 전체 수집:
`cd /root/groupbuy-live && git pull && FULL=1 node --env-file=/root/sales-order-sync/.env scripts/sync.mjs && ./run.sh`

## 주의

- **이 저장소는 공개다**(Pages 무료 조건). `data/*.json` 에 **고객 개인정보를 절대 담지 않는다** —
  받는분·주소·연락처·주문번호는 `sync.mjs` 에서 애초에 빼고 만든다. 일자·옵션·수량·금액·상태만 나간다.
- 취소·반품 건은 표에는 남기되(취소선) **합계에서는 제외**한다.
- 화면 하단에 **데이터 기준 시각**을 항상 표시한다. 3시간 넘게 낡으면 노란색으로 경고한다.
  ("화면은 멀쩡한데 숫자가 옛날 것"이 가장 위험한 고장이라서.)
- 서버 실행 흔적은 `/root/groupbuy-live/run.log` 에 남는다. 멈췄는지 확인할 때 여기부터 본다.

## 자주 하는 확인

```bash
ssh -i ~/.ssh/darimati-ncp root@49.50.128.134
tail -30 /root/groupbuy-live/run.log      # 마지막 실행이 언제였나
crontab -l | grep groupbuy                # 자동 실행이 살아 있나
```
