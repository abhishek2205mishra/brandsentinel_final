// Small inline icon set (24px, stroke). Decorative by default (aria-hidden).
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' };
const I = (d) => function Icon(props) { return <svg viewBox="0 0 24 24" aria-hidden="true" {...P} {...props}>{d}</svg>; };

export const IconClock = I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconAlert = I(<><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17.5v.01" /></>);
export const IconDoc = I(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>);
export const IconCheck = I(<><circle cx="12" cy="12" r="9" /><path d="M8 12.5l3 3 5-6" /></>);
export const IconShield = I(<><path d="M12 3l8 3v6c0 5-3.5 8-8 9.5C7.5 20 4 17 4 12V6z" /><path d="M8.5 12l2.5 2.5L15.5 10" /></>);
export const IconSpark = I(<><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" /></>);
export const IconLock = I(<><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
export const IconEye = I(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const IconSun = I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
export const IconMoon = I(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />);
export const IconBell = I(<><path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 20a2 2 0 0 0 4 0" /></>);
export const IconUp = I(<path d="M7 14l5-5 5 5" />);
export const IconDown = I(<path d="M7 10l5 5 5-5" />);
export const IconDash = I(<path d="M6 12h12" />);
export const IconPlus = I(<path d="M12 5v14M5 12h14" />);
export const IconBook = I(<><path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 0-2 2z" /><path d="M4 19V5" /></>);
