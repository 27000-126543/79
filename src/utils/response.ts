import { Response } from 'express';

export function success<T>(res: Response, data: T, message = 'success', statusCode = 200) {
  return res.status(statusCode).json({
    code: 0,
    message,
    data,
  });
}

export function fail(res: Response, message: string, statusCode = 400, errors?: unknown) {
  return res.status(statusCode).json({
    code: statusCode,
    message,
    errors,
  });
}

export class AppError extends Error {
  statusCode: number;
  errors?: unknown;

  constructor(message: string, statusCode = 400, errors?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.name = 'AppError';
  }
}
