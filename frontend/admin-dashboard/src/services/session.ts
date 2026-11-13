import type { StaffProfile, StaffSession } from "./types";

const KEY = 'scfrms.staffSession';

export type StoredSession = {
    token: string;
    expiresAt: number;
    staff: StaffProfile;
}

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