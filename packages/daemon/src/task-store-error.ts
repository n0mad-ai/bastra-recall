/** The error every layer of the task store throws; imports no task module. */
export class TaskStoreError extends Error {
  constructor(
    public readonly code: "corrupt" | "unsupported_version" | "conflict" | "capacity" | "invalid_backup",
    message: string
  ) {
    super(message);
    this.name = "TaskStoreError";
  }
}
