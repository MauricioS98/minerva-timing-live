/** sessionStorage key for unlocked event management panels */
export function eventAuthKey(eventId: string): string {
  return `minerva-event-auth:${eventId}`;
}

export function isEventUnlocked(eventId: string): boolean {
  try {
    return sessionStorage.getItem(eventAuthKey(eventId)) === "1";
  } catch {
    return false;
  }
}

export function markEventUnlocked(eventId: string): void {
  try {
    sessionStorage.setItem(eventAuthKey(eventId), "1");
  } catch {
    /* ignore */
  }
}

export function clearEventUnlock(eventId: string): void {
  try {
    sessionStorage.removeItem(eventAuthKey(eventId));
  } catch {
    /* ignore */
  }
}
