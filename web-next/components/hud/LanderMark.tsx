"use client";

/** The craft itself as the product mark: descent stage, legs, plume. */
export function LanderMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    >
      {/* body */}
      <path d="M8.5 7h7l1 5h-9l1-5z" fill="currentColor" opacity=".92" />
      {/* upper deck */}
      <rect x="10" y="4" width="4" height="3" rx=".6" fill="currentColor" opacity=".7" />
      {/* legs */}
      <path
        d="M8 12L4.5 18M16 12l3.5 6M10 12l-1.5 6M14 12l1.5 6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity=".75"
      />
      {/* footpads */}
      <circle cx="4.5" cy="18.6" r="1.1" fill="currentColor" opacity=".9" />
      <circle cx="19.5" cy="18.6" r="1.1" fill="currentColor" opacity=".9" />
      {/* plume */}
      <path d="M11 12.4h2l-1 3.4-1-3.4z" fill="currentColor" opacity=".45" />
    </svg>
  );
}
