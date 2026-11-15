import React, { useEffect, useState } from "react";
import { Copy, Mail, X } from "lucide-react";
import wechatQr from "../../assets/pay/wechat.png";
import alipayQr from "../../assets/pay/alipay.png";
import { openExternalUrl, syncErrorText } from "../../api/sync";
import { createProOrder, PRO_PRICE, PRO_SUPPORT_EMAIL, type LicenseStatus, type StoreOrder } from "../../api/pro";

export interface PurchaseDialogProps {
  status: LicenseStatus;
  onClose: () => void;
  onNotify: (msg: string) => void;
}

/** 购买永久版：创建订单 → 扫码付款 → 截图连同订单信息发邮件 → 核对后收到激活码 */
export function PurchaseDialog({ status, onClose, onNotify }: PurchaseDialogProps) {
  const [order, setOrder] = useState<StoreOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pay, setPay] = useState<"wechat" | "alipay">("wechat");

  useEffect(() => {
    if (!status.loggedIn) return;
    createProOrder()
      .then(setOrder)
      .catch((e) => setError(syncErrorText(e)));
  }, [status.loggedIn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const amount = order ? `¥${(order.amountCents / 100).toFixed(2)}` : PRO_PRICE;
  const orderText = order
    ? [
        `订单号：${order.id}`,
        `商品：${order.productName}`,
        `金额：${amount}`,
        `付款码：${order.payRef}`,
        `通行证账号：${status.account ?? ""}`,
        `本机：${status.machineName}`,
      ].join("\n")
    : "";

  const copy = () => {
    navigator.clipboard
      ?.writeText(orderText)
      .then(() => onNotify("订单信息已复制"))
      .catch(() => onNotify("复制失败，请手动截图"));
  };

  const mail = () => {
    const subject = `小悦笔记永久版购买 ${order?.id ?? ""}`;
    const body = `${orderText}\n\n（请附上付款截图）`;
    openExternalUrl(`mailto:${PRO_SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`).catch(() =>
      onNotify(`请发邮件到 ${PRO_SUPPORT_EMAIL}`)
    );
  };

  return (
    <div className="nb-modal-backdrop" onMouseDown={onClose}>
      <div
        className="nb-modal-card nb-purchase-card"
        role="dialog"
        aria-modal="true"
        aria-label="购买永久版"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="nb-modal-header">
          <div className="nb-modal-title">
            <span>购买永久版</span>
          </div>
          <button type="button" className="nb-icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="nb-purchase-body">
          {!status.loggedIn ? (
            <div className="nb-settings-sub nb-purchase-empty">
              请先登录 FWPT 通行证。激活码会绑定到你的账号，换电脑后登录即可恢复。
            </div>
          ) : (
            <>
              <div className="nb-purchase-amount">
                <span>小悦笔记永久版 · 一次购买</span>
                <strong>{amount}</strong>
              </div>

              <div className="nb-purchase-grid">
                <div className="nb-purchase-qr">
                  <div className="nb-purchase-tabs" role="tablist">
                    <button type="button" role="tab" aria-selected={pay === "wechat"} onClick={() => setPay("wechat")}>
                      微信
                    </button>
                    <button type="button" role="tab" aria-selected={pay === "alipay"} onClick={() => setPay("alipay")}>
                      支付宝
                    </button>
                  </div>
                  <img src={pay === "wechat" ? wechatQr : alipayQr} alt={pay === "wechat" ? "微信收款码" : "支付宝收款码"} />
                </div>

                <div className="nb-purchase-info">
                  {order ? (
                    <dl className="nb-purchase-order">
                      <dt>订单号</dt>
                      <dd>{order.id}</dd>
                      <dt>通行证</dt>
                      <dd>{status.account}</dd>
                      <dt>付款码</dt>
                      <dd className="nb-purchase-ref">{order.payRef}</dd>
                    </dl>
                  ) : (
                    !error && <div className="nb-settings-sub">正在创建订单…</div>
                  )}
                  <ol className="nb-purchase-steps">
                    <li>扫码付款 {amount}，备注填写付款码</li>
                    <li>
                      截图付款记录和本订单信息，发送到 <b>{PRO_SUPPORT_EMAIL}</b>
                    </li>
                    <li>核对无误后，激活码会发到你的邮箱，在「永久版」页输入即可；一个激活码可在 3 台电脑使用</li>
                  </ol>
                </div>
              </div>

              {error && (
                <div className="nb-sync-error" role="alert">
                  {error}
                </div>
              )}

              <div className="nb-settings-actions-bar nb-purchase-actions">
                <button type="button" className="nb-btn-secondary" disabled={!order} onClick={copy}>
                  <Copy size={14} /> 复制订单信息
                </button>
                <button type="button" className="nb-btn-primary" disabled={!order} onClick={mail}>
                  <Mail size={14} /> 发送邮件
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
