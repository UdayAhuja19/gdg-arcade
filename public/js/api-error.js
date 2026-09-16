// Errors carry a message that can be shown to players as-is.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
