// One error shape for the whole API: { error: { code, message, details?, requestId } }.

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = "authentication required") =>
  new AppError(401, "unauthorized", message);
export const forbidden = (message = "not allowed") => new AppError(403, "forbidden", message);
export const notFound = (message = "not found") => new AppError(404, "not_found", message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
