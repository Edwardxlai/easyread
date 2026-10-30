import * as React from 'react';

export const TableIcon = React.memo((props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 9v12M15 9v12" />
  </svg>
));
TableIcon.displayName = 'TableIcon';

export const ZoomIcon = React.memo((props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <circle cx="10" cy="10" r="7" />
    <path d="m15 15 6 6M7 10h6M10 7v6" />
  </svg>
));
ZoomIcon.displayName = 'ZoomIcon';
