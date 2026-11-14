// A tiny path router for the three LIFF pages. The LINE message buttons open
// https://liff.line.me/<liffId>/tickets/<id>[/reopen]; after liff.init the
// page is at <endpoint>/tickets/<id>[/reopen] (Amplify may add a trailing /).
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'report' }
  | { name: 'ticket'; ticketId: string }
  | { name: 'reopen'; ticketId: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'tickets' && parts[1]) {
    let ticketId: string;
    try {
      ticketId = decodeURIComponent(parts[1]);
    } catch {
      return { name: 'report' }; // malformed %-escape
    }
    if (parts.length === 2) return { name: 'ticket', ticketId };
    if (parts.length === 3 && parts[2] === 'reopen') {
      return { name: 'reopen', ticketId };
    }
  }
  return { name: 'report' };
}

export function ticketPath(ticketId: string): string {
  return `/tickets/${encodeURIComponent(ticketId)}`;
}

export function reopenPath(ticketId: string): string {
  return `${ticketPath(ticketId)}/reopen`;
}

// Moves to another page without reloading, so LIFF stays initialised.
export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo(0, 0);
}

// The current route; updates on navigate() and the phone's Back button.
export function useRoute(): Route {
  const [route, setRoute] = useState(() =>
    parseRoute(window.location.pathname),
  );
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return route;
}
