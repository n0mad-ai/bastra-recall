/** SessionStart transport format shared by the session lane and its Doctor probe. */
export function sessionOutput(context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  });
}

export const DOCTOR_SESSION_PATH = "/hook/session/doctor";
