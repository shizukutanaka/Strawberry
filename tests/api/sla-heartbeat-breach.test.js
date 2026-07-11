// SLA heartbeat-breach sweep tests.
//
// When a provider's box dies mid-rental (its heartbeats stop) the platform must
// not keep the renter paying for a dead GPU until the multi-hour max-duration
// timeout. sweepHeartbeatSlaBreaches() detects an active order whose provider
// (lender) heartbeat has gone stale beyond the SLA grace window, terminates it,
// settles the escrow pro-rata for only the delivered portion (no setup-fee floor
// since the fault is the provider's), and penalizes the provider's reliability.

const orderRouter = require('../../src/api/routes/order');
const OrderRepository = require('../../src/db/json/OrderRepository');
const GpuRepository = require('../../src/db/json/GpuRepository');
const EscrowRepository = require('../../src/db/json/EscrowRepository');
const UptimeRepository = require('../../src/db/json/UptimeRepository');
const providerUptime = require('../../src/reputation/provider-uptime');
const { createEscrowService } = require('../../src/payments/escrow-service');

const sessions = orderRouter._usageSessions;
const OrderUsageSession = orderRouter._OrderUsageSession;
const sweep = orderRouter._sweepHeartbeatSlaBreaches;

function cleanupProvider(providerId) {
  const rec = UptimeRepository.getByProviderId(providerId);
  if (rec) UptimeRepository.delete(rec.id);
}

describe('SLA heartbeat-breach sweep', () => {
  it('terminates a stalled active order, settles pro-rata, and penalizes the provider', () => {
    const providerId = `slaprov-${Date.now()}`;
    const gpu = GpuRepository.create({
      name: 'SLA GPU', vendor: 'NVIDIA', model: 'RTX-SLA', memoryGB: 8,
      pricePerHour: 1000, providerId,
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId: 'sla-renter', providerId,
      status: 'active', durationMinutes: 60, pricePerHour: 1000, totalPrice: 1000,
      startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    });

    // A funded (HELD) escrow for the order.
    const escrowSvc = createEscrowService();
    const escrow = escrowSvc.create({ orderId: order.id, amountSats: 1000, feeRate: 0 });
    escrowSvc.markPaid(escrow.id);
    expect(EscrowRepository.getById(escrow.id).state).toBe('HELD');

    // A live session that delivered 30 of 60 minutes, whose provider heartbeat
    // then went stale 10 minutes ago (well beyond the 5-minute SLA default).
    const now = Date.now();
    const session = new OrderUsageSession(order.id, providerId, 'sla-renter');
    session.accumulatedSeconds = 30 * 60; // 50% delivered
    session.usageStart = null;
    session.lastLenderHeartbeat = now - 10 * 60 * 1000;
    session.lastRenterHeartbeat = now - 10 * 60 * 1000;
    sessions.set(order.id, session);

    const breached = sweep(now);
    expect(breached.some(b => b.id === order.id)).toBe(true);

    // Order terminated with SLA-breach markers and ~0.5 delivered.
    const after = OrderRepository.getById(order.id);
    expect(after.status).toBe('completed');
    expect(after.slaBreach).toBe(true);
    expect(after.slaBreachReason).toBe('provider_heartbeat_lost');
    expect(after.deliveredRatio).toBeCloseTo(0.5, 2);

    // Escrow settled for the delivered portion.
    const settledEscrow = EscrowRepository.getById(escrow.id);
    expect(settledEscrow.state).toBe('SETTLED');
    expect(settledEscrow.settlement).toBeTruthy();

    // Provider reliability penalized: a breach recorded, score dips.
    const rel = providerUptime.getReliability(providerId);
    expect(rel.breaches).toBe(1);
    expect(rel.score).not.toBeNull();
    expect(rel.score).toBeLessThan(1);

    // Session cleaned up.
    expect(sessions.has(order.id)).toBe(false);

    cleanupProvider(providerId);
  });

  it('ignores active orders whose provider heartbeat is still fresh', () => {
    const providerId = `slafresh-${Date.now()}`;
    const gpu = GpuRepository.create({
      name: 'Fresh GPU', vendor: 'NVIDIA', model: 'RTX-FRESH', memoryGB: 8,
      pricePerHour: 1000, providerId,
    });
    const order = OrderRepository.create({
      gpuId: gpu.id, userId: 'fresh-renter', providerId,
      status: 'active', durationMinutes: 60, pricePerHour: 1000, totalPrice: 1000,
    });
    const now = Date.now();
    const session = new OrderUsageSession(order.id, providerId, 'fresh-renter');
    session.lastLenderHeartbeat = now - 30 * 1000; // 30s ago — well within SLA
    sessions.set(order.id, session);

    const breached = sweep(now);
    expect(breached.some(b => b.id === order.id)).toBe(false);
    expect(OrderRepository.getById(order.id).status).toBe('active');

    sessions.delete(order.id);
    cleanupProvider(providerId);
  });

  it('ignores sessions with no provider heartbeat at all (cannot prove a dead box)', () => {
    const providerId = `slanohb-${Date.now()}`;
    const order = OrderRepository.create({
      gpuId: 'g', userId: 'r', providerId,
      status: 'active', durationMinutes: 60, pricePerHour: 1000, totalPrice: 1000,
    });
    const now = Date.now();
    const session = new OrderUsageSession(order.id, providerId, 'r');
    session.lastLenderHeartbeat = null; // never beat
    sessions.set(order.id, session);

    const breached = sweep(now);
    expect(breached.some(b => b.id === order.id)).toBe(false);
    expect(OrderRepository.getById(order.id).status).toBe('active');

    sessions.delete(order.id);
    cleanupProvider(providerId);
  });
});
