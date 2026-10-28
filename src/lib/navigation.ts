let leaving = false;

/**
 * Full-page navigation to the login page. Used on sign-out and on an expired session:
 * reloading discards all client state (query cache included) in one step, so the next user
 * can't see the previous user's data and no mounted query can refetch in the meantime.
 * Idempotent, so several simultaneous 401s trigger a single navigation.
 */
export function goToLogin(): void {
  if (leaving) return;
  leaving = true;
  window.location.replace("/login");
}
