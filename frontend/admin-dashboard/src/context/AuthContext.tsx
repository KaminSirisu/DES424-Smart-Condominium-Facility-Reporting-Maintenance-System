import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode
} from 'react';
import {
    clearSession,
    getSession,
    saveSession,
    type StoredSession
} from '../services/session';
import type { StaffSession } from '../services/types';

type AuthValue = {
    session: StoredSession | null;
    signIn: (session: StaffSession) => void;
    signOut: () => void;
};

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    // Lazy initial state: read storage once, on first render.
    const [ session, setSession ] = useState<StoredSession | null>(() => getSession());

    const signIn = useCallback((s: StaffSession) => {
        setSession(saveSession(s));
    }, []);

    const signOut = useCallback(() => {
        clearSession();
        setSession(null);
    }, []);

    const value = useMemo(() => ({ session, signIn, signOut }), [session, signIn, signOut]);
    return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthValue {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
    return ctx;
}