import type { StaffProfile, StaffSession } from './types';

const KEY = 'scfrms.staffSession';

export type StoredSession = {
  token: string;
  expiresAt: number;
  staff: StaffProfile;
};

export function saveSession(session: StaffSession) {
  const stored: StoredSession = {
    token: session.accessToken,
    expiresAt: Date.now() + session.expiresInSeconds * 1000,
    staff: session.staff,
  };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage blocked (private mode): the user just has to log in again.
  }
  return stored;
}

export function getSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredSession;
    if (stored.expiresAt <= Date.now()) {
      clearSession();
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
/** Where each role lands after login. */
export function homePath(role: StaffProfile['role']): string {
  return role === 'TECHNICIAN' ? '/tech' : '/';
}

/** Return to an emailed ticket only when its route belongs to the signed-in role. */
export function postLoginPath(
  role: StaffProfile['role'],
  requested: unknown,
): string {
  if (typeof requested !== 'string') return homePath(role);
  const pattern =
    role === 'MANAGER'
      ? /^\/tickets\/tkt_[0-9a-f]{26}$/
      : /^\/tech\/jobs\/tkt_[0-9a-f]{26}$/;
  return pattern.test(requested) ? requested : homePath(role);
}
