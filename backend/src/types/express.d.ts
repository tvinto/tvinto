import { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';

export interface TypedResponse<ResBody = unknown> extends ExpressResponse {
  json: (body: ResBody) => this;
}

export interface TypedRequest<T = unknown, U = ExpressRequest['params'], V = ExpressRequest['query']> extends ExpressRequest {
  body: T;
  params: U;
  query: V;
}

export type AsyncRequestHandler<T = unknown, U = ExpressRequest['params'], V = ExpressRequest['query']> = (
  req: TypedRequest<T, U, V>,
  res: TypedResponse,
  next: NextFunction
) => Promise<void>;
