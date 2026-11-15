import React, { useState } from "react";
import wechatQr from "../../assets/donate/wechat.png";
import alipayQr from "../../assets/donate/alipay.png";

type Channel = "wechat" | "alipay";

const CHANNELS: { id: Channel; label: string; img: string; hint: string }[] = [
  { id: "wechat", label: "微信", img: wechatQr, hint: "打开微信，扫一扫" },
  { id: "alipay", label: "支付宝", img: alipayQr, hint: "打开支付宝，扫一扫" },
];

/** 设置 →「支持作者」：全部功能免费，自愿打赏 */
export function DonatePanel() {
  const [channel, setChannel] = useState<Channel>("wechat");
  const current = CHANNELS.find((c) => c.id === channel) ?? CHANNELS[0];

  return (
    <div className="nb-settings-section-stack">
      <div>
        <h3 className="nb-settings-heading">支持作者</h3>
        <p className="nb-settings-desc">
          小悦笔记的全部功能都免费，没有广告，也不限制笔记数量。如果它帮到了你，可以请作者喝杯咖啡，
          打赏会用在后续开发和测试上。打赏完全自愿，不影响任何功能。
        </p>
      </div>

      <div className="nb-settings-card-box nb-donate">
        <div className="nb-donate-tabs" role="tablist" aria-label="打赏方式">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={channel === c.id}
              className={`nb-donate-tab is-${c.id}${channel === c.id ? " is-active" : ""}`}
              onClick={() => setChannel(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <figure className={`nb-donate-qr is-${current.id}`}>
          <img src={current.img} alt={`${current.label}收款码`} width={200} height={200} />
          <figcaption>{current.hint}，金额随意</figcaption>
        </figure>
      </div>

      <p className="nb-settings-sub">
        想要的功能、遇到的问题，欢迎在「意见反馈」里告诉我们，这同样是很大的支持。
      </p>
    </div>
  );
}
