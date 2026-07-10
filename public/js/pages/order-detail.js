// public/js/pages/order-detail.js — the order lifecycle state machine.
// Renders differently based on order.status AND the viewer's relationship to
// the order (renter = order.userId, provider = order.providerId, or admin).
//
// Cleanup contract: this page sets up polling intervals (payment status,
// heartbeat) — render() returns a cleanup function that the router calls
// before navigating away, or these intervals leak indefinitely.
import { el, toast, statusBadge, timeline, fmtDate, fmtSats, fmtJpy, confirmDialog } from '../ui.js';
import { api, ApiError } from '../api.js';
import { getUser } from '../auth.js';
import { getRate, priceLine } from '../rate.js';
import { navigate } from '../router.js';

const PAYMENT_POLL_MS = 5000;
const HEARTBEAT_MS = 60000;

export async function render(container, params) {
  const orderId = params.id;
  const user = getUser();
  const timers = [];
  const cleanup = () => timers.forEach((t) => clearInterval(t));

  const root = el('div', { class: 'stack' });
  container.appendChild(root);

  async function load() {
    root.replaceChildren(el('div', { class: 'skeleton skeleton-line', style: 'width:40%' }));
    let order, gpu, paymentInfo, rateInfo;
    try {
      order = (await api.getOrder(orderId)).order;
      [gpu, paymentInfo, rateInfo] = await Promise.all([
        api.getGpu(order.gpuId).then((r) => r.gpu).catch(() => null),
        api.getOrderPayment(orderId).catch(() => ({ payments: [], escrows: [] })),
        getRate(),
      ]);
    } catch (err) {
      root.replaceChildren(el('div', { class: 'empty-state' },
        el('div', { class: 'icon' }, '⚠️'),
        el('h3', {}, '注文の取得に失敗しました'),
        el('p', { class: 'muted' }, err instanceof ApiError ? err.message : ''),
      ));
      return;
    }
    renderOrder(order, gpu, paymentInfo, rateInfo);
  }

  function renderOrder(order, gpu, paymentInfo, rateInfo) {
    timers.forEach((t) => clearInterval(t));
    timers.length = 0;

    const isRenter = order.userId === user.id;
    const isProvider = order.providerId && order.providerId === user.id;
    const isAdmin = user.role === 'admin';
    const price = priceLine(order.totalPrice, rateInfo);

    const header = el('div', { class: 'stack' },
      el('div', { class: 'section-title' },
        el('h1', {}, gpu ? gpu.name : `注文 #${order.id.slice(0, 8)}`),
        statusBadge(order.status),
      ),
      timeline(order),
      el('div', { class: 'row', style: 'gap:24px;flex-wrap:wrap' },
        el('div', {}, el('div', { class: 'muted', style: 'font-size:0.8rem' }, '利用時間'), el('div', {}, `${order.durationMinutes}分`)),
        el('div', {}, el('div', { class: 'muted', style: 'font-size:0.8rem' }, '合計金額'),
          el('div', {}, price.sats, price.jpy ? el('div', { class: 'muted', style: 'font-size:0.8rem' }, price.jpy) : null)),
        el('div', {}, el('div', { class: 'muted', style: 'font-size:0.8rem' }, '作成日時'), el('div', {}, fmtDate(order.createdAt))),
      ),
    );

    const body = el('div', { class: 'stack' });
    const card = el('div', { class: 'card stack' }, header, el('hr', { style: 'border:none;border-top:1px solid var(--color-border);width:100%' }), body);
    root.replaceChildren(card);

    if (order.status === 'pending') renderPending(body, order, isRenter, isProvider, isAdmin);
    else if (order.status === 'matched') renderMatched(body, order, paymentInfo, isRenter, isProvider, isAdmin, rateInfo);
    else if (order.status === 'active') renderActive(body, order, isRenter, isProvider, isAdmin);
    else if (order.status === 'completed') renderCompleted(body, order, isRenter);
    else if (order.status === 'cancelled') body.appendChild(el('div', { class: 'banner banner-warning' }, 'この注文はキャンセルされました。'));
    else if (order.status === 'disputed') renderDisputed(body, order, isRenter, isProvider, isAdmin);
  }

  // Only the renter, the GPU's provider, or an admin may raise a dispute — the
  // server enforces this too (403 otherwise), but hiding it client-side avoids
  // showing an action that would just fail for an unrelated viewer. Server
  // also requires a paid payment for 'matched'-state disputes (unpaid orders
  // can't be disputed to prevent a free-GPU DoS via griefing); callers of this
  // helper for 'matched' only invoke it once a paid payment is confirmed, so
  // that rule doesn't need duplicating here.
  function renderDisputeAction(body, order, isRenter, isProvider, isAdmin) {
    if (!isRenter && !isProvider && !isAdmin) return;
    const openBtn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:8px' }, '係争を申請する');
    const formBox = el('div', { style: 'display:none;margin-top:8px' });
    openBtn.addEventListener('click', () => {
      openBtn.style.display = 'none';
      formBox.style.display = '';
    });
    const reasonInput = el('textarea', { rows: '3', placeholder: '係争の理由（任意）' });
    const submitBtn = el('button', {
      class: 'btn btn-danger btn-sm',
      onClick: async () => {
        submitBtn.disabled = true;
        try {
          await api.raiseDispute(order.id, reasonInput.value.trim());
          toast('係争を申請しました', 'info');
          await load();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '係争の申請に失敗しました', 'error');
          submitBtn.disabled = false;
        }
      },
    }, '申請を送信');
    const cancelBtn = el('button', {
      class: 'btn btn-ghost btn-sm',
      onClick: () => { formBox.style.display = 'none'; openBtn.style.display = ''; },
    }, 'キャンセル');
    formBox.append(
      el('div', { class: 'field' }, el('label', {}, '係争の理由'), reasonInput),
      el('div', { class: 'row' }, submitBtn, cancelBtn),
    );
    body.appendChild(el('div', {}, openBtn, formBox));
  }

  function disputantLabel(order, userId) {
    if (!userId) return '不明';
    if (userId === order.userId) return '借り手';
    if (userId === order.providerId) return 'プロバイダー';
    return '不明';
  }

  function renderDisputed(body, order, isRenter, isProvider, isAdmin) {
    const dispute = order.dispute || {};
    body.appendChild(el('div', { class: 'stack' },
      el('div', { class: 'banner banner-warning' }, 'この注文は係争中です。管理者の対応をお待ちください。'),
      el('div', { class: 'card', style: 'background:var(--color-surface-2)' },
        el('div', { class: 'muted', style: 'font-size:0.8rem' }, `申請者: ${disputantLabel(order, dispute.raisedBy)}`),
        el('div', { class: 'muted', style: 'font-size:0.8rem' }, `申請日時: ${fmtDate(dispute.raisedAt)}`),
        dispute.reason ? el('p', {}, dispute.reason) : el('p', { class: 'muted' }, '（理由の記載なし）'),
      ),
    ));

    if (!isAdmin) return;

    let decision = null;
    const refundBtn = el('button', {
      class: 'btn btn-ghost',
      onClick: (e) => {
        decision = 'refund';
        [refundBtn, upholdBtn].forEach((b) => b.classList.remove('btn-primary'));
        e.target.classList.add('btn-primary');
      },
    }, '返金（借り手勝訴）');
    const upholdBtn = el('button', {
      class: 'btn btn-ghost',
      onClick: (e) => {
        decision = 'uphold';
        [refundBtn, upholdBtn].forEach((b) => b.classList.remove('btn-primary'));
        e.target.classList.add('btn-primary');
      },
    }, '棄却（プロバイダー勝訴）');
    const noteInput = el('textarea', { rows: '3', placeholder: '裁定の備考（任意）' });
    const submitBtn = el('button', {
      class: 'btn btn-danger',
      onClick: async () => {
        if (!decision) { toast('裁定を選択してください', 'error'); return; }
        const ok = await confirmDialog(`この注文を「${decision === 'refund' ? '返金' : '棄却'}」で裁定しますか？取り消せません。`);
        if (!ok) return;
        submitBtn.disabled = true;
        try {
          await api.resolveDispute(order.id, decision, noteInput.value.trim());
          toast('係争を裁定しました', 'success');
          await load();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '裁定に失敗しました', 'error');
          submitBtn.disabled = false;
        }
      },
    }, '裁定を確定');

    body.appendChild(el('div', { class: 'stack' },
      el('h3', {}, '管理者裁定'),
      el('div', { class: 'row' }, refundBtn, upholdBtn),
      noteInput,
      submitBtn,
    ));
  }

  function renderPending(body, order, isRenter, isProvider, isAdmin) {
    if (isProvider || isAdmin) {
      const acceptBtn = el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          acceptBtn.disabled = true;
          try {
            await api.acceptOrder(order.id);
            toast('注文を承認しました', 'success');
            await load();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : '承認に失敗しました', 'error');
            acceptBtn.disabled = false;
          }
        },
      }, '承認する');
      const rejectBtn = el('button', {
        class: 'btn btn-danger',
        onClick: async () => {
          rejectBtn.disabled = true;
          try {
            await api.rejectOrder(order.id);
            toast('注文を拒否しました', 'info');
            await load();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : '拒否に失敗しました', 'error');
            rejectBtn.disabled = false;
          }
        },
      }, '拒否する');
      body.appendChild(el('div', { class: 'row' }, acceptBtn, rejectBtn));
    } else {
      body.appendChild(el('div', { class: 'banner banner-info' }, 'プロバイダーの承認をお待ちください。'));
    }
  }

  function renderMatched(body, order, paymentInfo, isRenter, isProvider, isAdmin, rateInfo) {
    const paidPayment = paymentInfo.payments.find((p) => p.status === 'paid');
    const pendingPayment = paymentInfo.payments.find((p) => p.status === 'pending');

    if (!isRenter) {
      // The backend allows disputing a paid 'matched' order from either side
      // (e.g. the renter paid but never starts the session) — surface that
      // to the provider too instead of only ever showing a generic waiting
      // banner regardless of payment state.
      body.appendChild(el('div', { class: 'banner banner-info' },
        paidPayment ? '支払いが完了しました。借り手の利用開始をお待ちください。' : '借り手の支払いをお待ちください。'));
      if (paidPayment) renderDisputeAction(body, order, isRenter, isProvider, isAdmin);
      return;
    }

    if (paidPayment) {
      body.appendChild(el('div', { class: 'banner banner-success' }, '支払いが完了しました。利用を開始できます。'));
      const startBtn = el('button', {
        class: 'btn btn-primary',
        onClick: async () => {
          startBtn.disabled = true;
          startBtn.textContent = '開始中…';
          try {
            const res = await api.startOrder(order.id);
            if (res.allocationDetails && res.allocationDetails.accessInfo && res.allocationDetails.accessInfo.deliveryImplemented === false) {
              toast('利用を開始しました（接続情報の自動配信は準備中です）', 'info');
            } else {
              toast('利用を開始しました', 'success');
            }
            await load();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : '開始に失敗しました', 'error');
            startBtn.disabled = false;
            startBtn.textContent = '利用を開始する';
          }
        },
      }, '利用を開始する');
      body.appendChild(startBtn);
      renderDisputeAction(body, order, isRenter, isProvider, isAdmin);
      return;
    }

    if (pendingPayment) {
      renderPendingPaymentPanel(body, order, pendingPayment, rateInfo);
      return;
    }

    renderPaymentMethodChooser(body, order, rateInfo);
  }

  function renderPendingPaymentPanel(body, order, payment, rateInfo) {
    if (payment.method === 'lightning') {
      body.appendChild(el('div', { class: 'banner banner-info' }, 'Lightning請求書への支払いをお待ちしています。'));
      pollPaymentStatus(body, payment.id, order);
    } else {
      const price = priceLine(order.totalPrice, rateInfo);
      body.appendChild(
        el('div', { class: 'banner banner-warning' },
          `銀行振込の確認待ちです。金額: ${price.jpy || fmtJpy(null)}。振込完了後、管理者の承認をお待ちください。`)
      );
      pollPaymentStatus(body, payment.id, order);
    }
  }

  function pollPaymentStatus(body, paymentId, order) {
    const statusLine = el('p', { class: 'muted' }, '状態を確認しています…');
    body.appendChild(statusLine);
    const timer = setInterval(async () => {
      try {
        const status = await api.paymentStatus(paymentId);
        if (status.status === 'paid') {
          clearInterval(timer);
          toast('支払いが確認されました', 'success');
          await load();
        }
      } catch (_err) { /* transient poll failure — keep trying */ }
    }, PAYMENT_POLL_MS);
    timers.push(timer);
  }

  function renderPaymentMethodChooser(body, order, rateInfo) {
    const resultBox = el('div');
    const lightningBtn = el('button', {
      class: 'btn btn-primary',
      onClick: async () => {
        lightningBtn.disabled = true;
        try {
          const res = await api.createPayment(order.id, 'lightning');
          renderLightningInvoice(resultBox, res, order);
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '請求書の作成に失敗しました', 'error');
          lightningBtn.disabled = false;
        }
      },
    }, '⚡ Lightningで支払う');
    const bankBtn = el('button', {
      class: 'btn btn-ghost',
      onClick: async () => {
        bankBtn.disabled = true;
        try {
          const res = await api.createPayment(order.id, 'bank_transfer');
          toast('銀行振込の申請を記録しました', 'success');
          resultBox.replaceChildren(el('div', { class: 'banner banner-warning' },
            `振込金額: ${fmtJpy(res.amountPaidJPY)}。振込完了後、管理者の承認をお待ちください。`));
          pollPaymentStatus(body, res.paymentId, order);
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '申請に失敗しました', 'error');
          bankBtn.disabled = false;
        }
      },
    }, '🏦 銀行振込で支払う');
    body.appendChild(el('div', { class: 'stack' },
      el('p', {}, 'お支払い方法を選択してください。'),
      el('div', { class: 'row' }, lightningBtn, bankBtn),
      resultBox,
    ));
  }

  function renderLightningInvoice(box, paymentRes, order) {
    const copyBtn = el('button', {
      class: 'btn btn-ghost btn-sm',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(paymentRes.paymentRequest);
          toast('コピーしました', 'success');
        } catch (_err) {
          toast('コピーに失敗しました', 'error');
        }
      },
    }, 'コピー');
    box.replaceChildren(
      el('div', { class: 'stack' },
        el('p', {}, `請求額: ${fmtSats(paymentRes.amountSats)}`),
        el('div', { class: 'copy-box' },
          el('div', { class: 'mono' }, paymentRes.paymentRequest),
          copyBtn,
        ),
        el('a', { href: `lightning:${paymentRes.paymentRequest}`, class: 'btn btn-primary btn-block' }, 'ウォレットで開く'),
        el('p', { class: 'muted', style: 'font-size:0.8rem' }, '支払い完了後、自動的に反映されます。'),
      )
    );
    pollPaymentStatus(box.parentElement, paymentRes.paymentId, order);
  }

  function renderActive(body, order, isRenter, isProvider, isAdmin) {
    const startedAt = order.startedAt ? new Date(order.startedAt).getTime() : Date.now();
    const totalMs = order.durationMinutes * 60 * 1000;
    const statusLine = el('p', {});
    const heartbeatLine = el('p', { class: 'muted', style: 'font-size:0.8rem' }, 'ハートビート: 待機中…');

    function updateElapsed() {
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = Math.max(0, totalMs - elapsedMs);
      const remMin = Math.floor(remainingMs / 60000);
      const remSec = Math.floor((remainingMs % 60000) / 1000);
      statusLine.textContent = remainingMs > 0
        ? `残り時間: ${remMin}分${remSec}秒`
        : '利用時間が終了しました。停止してください。';
    }
    updateElapsed();
    timers.push(setInterval(updateElapsed, 1000));

    async function sendHeartbeat(role) {
      try {
        const res = await api.heartbeat(order.id, role);
        heartbeatLine.textContent = `ハートビート: 正常（累計利用 ${res.usageSeconds || 0}秒）`;
      } catch (_err) {
        heartbeatLine.textContent = 'ハートビート: 送信に失敗しました';
      }
    }
    if (isRenter) { sendHeartbeat('renter'); timers.push(setInterval(() => sendHeartbeat('renter'), HEARTBEAT_MS)); }
    if (isProvider) { sendHeartbeat('lender'); timers.push(setInterval(() => sendHeartbeat('lender'), HEARTBEAT_MS)); }

    body.appendChild(el('div', { class: 'stack' }, statusLine, heartbeatLine));

    if (isRenter) {
      const stopBtn = el('button', {
        class: 'btn btn-danger',
        onClick: async () => {
          stopBtn.disabled = true;
          try {
            await api.stopOrder(order.id);
            toast('利用を停止しました', 'success');
            await load();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : '停止に失敗しました', 'error');
            stopBtn.disabled = false;
          }
        },
      }, '利用を停止する');
      body.appendChild(stopBtn);
    } else if (isProvider) {
      body.appendChild(el('p', { class: 'muted' }, 'プロバイダーは利用を停止できません。問題がある場合は管理者にお問い合わせください。'));
    }
    renderDisputeAction(body, order, isRenter, isProvider, isAdmin);
  }

  function renderCompleted(body, order, isRenter) {
    if (order.review) {
      body.appendChild(el('div', { class: 'stack' },
        el('p', {}, el('span', { class: 'stars' }, '★'.repeat(order.review.rating) + '☆'.repeat(5 - order.review.rating))),
        order.review.comment ? el('p', {}, order.review.comment) : null,
      ));
      return;
    }
    if (!isRenter) {
      body.appendChild(el('p', { class: 'muted' }, '注文が完了しました。'));
      return;
    }
    let selectedRating = 0;
    const stars = [1, 2, 3, 4, 5].map((n) =>
      el('button', {
        type: 'button',
        onClick: (e) => {
          selectedRating = n;
          [...e.target.parentElement.children].forEach((c, i) => c.classList.toggle('active', i < n));
        },
      }, '★')
    );
    const commentInput = el('textarea', { rows: '3', placeholder: 'コメント（任意）' });
    const submitBtn = el('button', {
      class: 'btn btn-primary',
      onClick: async () => {
        if (selectedRating < 1) { toast('評価を選択してください', 'error'); return; }
        submitBtn.disabled = true;
        try {
          await api.reviewOrder(order.id, selectedRating, commentInput.value.trim());
          toast('レビューを送信しました', 'success');
          await load();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '送信に失敗しました', 'error');
          submitBtn.disabled = false;
        }
      },
    }, 'レビューを送信');
    body.appendChild(el('div', { class: 'stack' },
      el('p', {}, '利用はいかがでしたか？'),
      el('div', { class: 'rating-input' }, ...stars),
      commentInput,
      submitBtn,
    ));
  }

  await load();
  return cleanup;
}
