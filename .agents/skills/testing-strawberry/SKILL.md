---
name: testing-strawberry
description: How to run and E2E-test the Strawberry P2P GPU marketplace SPA locally (mock LN, JSON data layer, role seeding, rate-limit pitfalls)
---

# Testing the Strawberry app

## Run the server
```
JWT_SECRET=<32+chars> SESSION_SECRET=<16+chars> ENCRYPTION_KEY=<16+chars> \
METRICS_AUTH_TOKEN=<any> RATE_LIMIT_MAX=1000 AUTH_RATE_LIMIT_MAX=100 \
NODE_ENV=development PORT=3000 node src/api/server.js
```
- `JWT_SECRET` must be ≥32 chars or `requireSecret` falls back to an **ephemeral secret** — every restart then invalidates all existing tokens (users get 401 + redirect to #/login).
- Raise `RATE_LIMIT_MAX`/`AUTH_RATE_LIMIT_MAX` for E2E runs — defaults are 60 req/min global and 10 req/15min on register/login; a handful of curl smoke tests + page loads exhaust the global limit fast.
- `/metrics` returns **401 without** `Authorization: Bearer $METRICS_AUTH_TOKEN` and **503 when the env var is unset** (non-test env). Set it to verify metrics.
- Mock LND activates automatically (no LND_PROTO_PATH). Invoices are created but **never settle** — Lightning payments stay pending forever by design. For a completable payment flow use `bank_transfer` + admin approval (see below).
- `p2p-network` warns "Cannot find module 'libp2p'" — expected, optional service; the API still serves.

## SPA structure
- Hash-routed vanilla JS: `#/market`, `#/register`, `#/login`, `#/gpus/new`, `#/my-gpus`, `#/orders`, `#/orders/:id`, `#/admin/payments`, `#/earnings`. API prefix is `/api/v1` (not `/api`).
- Password rules: 8–72 chars with lower+upper+digit+symbol (e.g. `Test1234!`). Username `[A-Za-z0-9]{3,30}`.
- Register role is limited to `user` (default) or `provider` (checkbox "プロバイダーとして登録する").

## Seeding an admin (register can't create one)
1. `POST /api/v1/users/register` (or UI) a normal user.
2. Edit `data/users.json`, set `role: 'admin'` for that user — JSON repos (`src/db/json/createJsonRepository.js`) re-read the file on every call, so the change is live **without restart**.
3. Log in **after** the edit — role is baked into the JWT at login, not read from DB per request.

## Order lifecycle for E2E
pending (renter creates via rent modal) → provider accepts via `POST /orders/:id/accept` (or order-detail UI 承認する) → `POST /payments/order/:id` `{paymentMethod:'bank_transfer'}` → admin approves at `#/admin/payments` (or `POST /payments/manual/approve/:id`) → renter `POST /orders/:id/start` (active, heartbeat) → `POST /orders/:id/stop` (completed) → `POST /orders/:id/review`.
- A provider can't order their own GPU (400 self-trade) — use a second account.
- Only ONE pending payment per order: creating a Lightning invoice first makes later `createPayment` calls return it idempotently. Choose bank_transfer first if you want the completable path.
- The `?next=` login redirect produces `#//orders/...` (double slash → page-not-found); navigate via the 注文 tab instead. Pre-existing quirk.

## Escrow notes
- Escrow records are created only by the BTC on-chain route (`/api/v1/payments/btc/...`); Lightning invoice and bank_transfer payments do NOT create escrows.
- To exercise `escrowSvc.cancel/settle` (the `lnAdapter`-wired paths) at runtime: seed `data/escrows.json` with `{orderId, amountSats, feeRate, state:'HELD', history:[], id:<uuid>, createdAt}` then `DELETE /api/v1/orders/:id` as the renter — the escrow goes CANCELED and history gains `LN_ACTIONS_EXECUTED` with honest `skipped: escrow has no <field>` entries for missing preimage/providerInvoice.

## Devin Secrets Needed
None — everything runs locally with generated/env-provided dev secrets.
