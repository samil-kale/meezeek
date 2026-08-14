export interface NotificationSettings {
  /** The agent finished responding, with nothing it started still running. */
  finished: boolean;
  /** The agent is blocked mid-turn on a permission prompt, an elicitation, or a question. */
  needsYou: boolean;
  /** The agent has been idle waiting for the next prompt — usually redundant with `finished`. */
  idleReminder: boolean;
}

/**
 * What every agent notifies about. Meezeek has no settings layer yet, so these are the
 * defaults sbc ships with rather than something the user can change.
 */
export const NOTIFICATIONS: NotificationSettings = {
  finished: true,
  needsYou: true,
  idleReminder: false
};
