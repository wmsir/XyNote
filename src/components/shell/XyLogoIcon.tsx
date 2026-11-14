import React, { useId } from "react";

export interface XyLogoIconProps {
  size?: number;
  className?: string;
}

export const XyLogoIcon: React.FC<XyLogoIconProps> = ({
  size = 22,
  className,
}) => {
  const gradId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block" }}
    >
      <defs>
        <linearGradient id={gradId} x1="24" y1="24" x2="488" y2="488" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#0EA5E9" />
        </linearGradient>
      </defs>
      <rect x="24" y="24" width="464" height="464" rx="108" fill={`url(#${gradId})`} />
      <path
        d="M146 152L256 282L366 152M256 282V384"
        stroke="#FFFFFF"
        strokeWidth="52"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="402" cy="110" r="16" fill="#A5F3FC" />
    </svg>
  );
};
