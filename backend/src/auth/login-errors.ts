import { ApiError } from '../tickets/types.js';

/** Answers the login and the MFA steps share (SR-09). */

export function wrongCredentials(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Incorrect email or password.');
}

export function wrongCode(): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', 'Incorrect code.');
}

export function tooManyAttempts(lockedUntil: string, now: Date): ApiError {
  const seconds = Math.ceil((Date.parse(lockedUntil) - now.getTime()) / 1000);
  return new ApiError(
    429,
    'RATE_LIMITED',
    'Too many failed logins. Please try again later.',
    { 'Retry-After': String(Math.max(1, seconds)) },
  );
}
