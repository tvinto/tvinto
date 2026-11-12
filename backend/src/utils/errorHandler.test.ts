import { NextFunction, Request, Response } from 'express';
import {
  AppError,
  catchAsync,
  describeError,
  errorResponse,
  globalErrorHandler,
  redactCredentials
} from './errorHandler';

const mockResponse = () => {
  const res = {
    statusCode: 0,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    }
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

describe('redactCredentials', () => {
  it('masks the credentials Xtream puts in every request URL', () => {
    const url = 'http://provider.example/player_api.php?username=joe&password=hunter2&action=get_live_streams';

    const redacted = redactCredentials(url);

    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('joe');
    expect(redacted).toContain('action=get_live_streams');
  });

  it('masks the first parameter as well as later ones', () => {
    expect(redactCredentials('?password=secret&username=joe')).toBe(
      '?password=<redacted>&username=<redacted>'
    );
  });

  it('stops at the parameter boundary rather than eating the rest of the URL', () => {
    expect(redactCredentials('?username=joe&action=x')).toBe('?username=<redacted>&action=x');
  });

  it('stops at quotes, so a URL embedded in a message stays readable', () => {
    expect(redactCredentials(`failed to reach "http://x/?password=secret" twice`)).toBe(
      `failed to reach "http://x/?password=<redacted>" twice`
    );
  });

  it('is case-insensitive, since parameter casing varies between providers', () => {
    expect(redactCredentials('?Password=secret')).toBe('?Password=<redacted>');
  });

  it('leaves text without credentials untouched', () => {
    expect(redactCredentials('connect ECONNREFUSED 10.0.0.1:80')).toBe(
      'connect ECONNREFUSED 10.0.0.1:80'
    );
  });
});

describe('describeError', () => {
  it('keeps the password out of an axios failure', () => {
    // The shape that leaked a real password to the log: axios attaches the
    // whole request config, and Xtream credentials live in the query string.
    const axiosError = {
      message: 'Request failed with status code 512',
      code: 'ERR_BAD_RESPONSE',
      response: { status: 512 },
      config: {
        url: 'http://provider.example/player_api.php?username=joe&password=hunter2'
      }
    };

    const described = describeError(axiosError);

    expect(described).not.toContain('hunter2');
    expect(described).toContain('status=512');
    expect(described).toContain('code=ERR_BAD_RESPONSE');
    expect(described).toContain('Request failed with status code 512');
  });

  it('redacts credentials that appear in the message itself', () => {
    const described = describeError(new Error('GET /live?username=joe&password=hunter2 failed'));
    expect(described).not.toContain('hunter2');
  });

  it('describes a plain error with just its message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the value itself when there is no message', () => {
    expect(describeError('something odd')).toBe('something odd');
  });

  it('reports a missing error rather than throwing', () => {
    expect(describeError(null)).toBe('unknown error');
    expect(describeError(undefined)).toBe('unknown error');
  });

  it('omits fields the error does not carry', () => {
    expect(describeError({ message: 'timeout', code: 'ECONNABORTED' })).toBe(
      'timeout code=ECONNABORTED'
    );
  });
});

describe('errorResponse', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.restoreAllMocks();
  });

  it('sends only the message, never the underlying error', async () => {
    const res = mockResponse();

    errorResponse(res, 'Failed to fetch categories', 502, {
      config: { url: 'http://x/?password=hunter2' }
    });

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, message: 'Failed to fetch categories' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('defaults to a 500', () => {
    const res = mockResponse();
    errorResponse(res, 'Something went wrong');
    expect(res.statusCode).toBe(500);
  });

  it('logs only the sanitised description in development', () => {
    // The raw error is an axios failure carrying the credential-bearing URL.
    process.env.NODE_ENV = 'development';
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    errorResponse(mockResponse(), 'Failed', 500, {
      message: 'Request failed',
      config: { url: 'http://x/?username=joe&password=hunter2' }
    });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });

  it('logs nothing outside development', () => {
    process.env.NODE_ENV = 'production';
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    errorResponse(mockResponse(), 'Failed', 500, new Error('boom'));

    expect(log).not.toHaveBeenCalled();
  });
});

describe('globalErrorHandler', () => {
  it('answers with the status the error carries', () => {
    const res = mockResponse();

    globalErrorHandler(new AppError('Not found', 404), {} as Request, res, jest.fn());

    expect(res.statusCode).toBe(404);
    expect(res.body.message).toBe('Not found');
  });

  it('falls back to a 500 for an error with no status', () => {
    const res = mockResponse();

    globalErrorHandler(new Error('boom'), {} as Request, res, jest.fn());

    expect(res.statusCode).toBe(500);
  });

  it('supplies a message when the error has none', () => {
    const res = mockResponse();

    globalErrorHandler({}, {} as Request, res, jest.fn());

    expect(res.body.message).toBe('Something went wrong');
  });
});

describe('catchAsync', () => {
  it('passes a rejection to next instead of leaving it unhandled', async () => {
    const boom = new Error('boom');
    const next = jest.fn() as NextFunction;

    catchAsync(() => Promise.reject(boom))({} as Request, mockResponse(), next);
    await Promise.resolve();

    expect(next).toHaveBeenCalledWith(boom);
  });

  it('stays out of the way when the handler succeeds', async () => {
    const next = jest.fn() as NextFunction;
    const handler = jest.fn().mockResolvedValue(undefined);

    catchAsync(handler)({} as Request, mockResponse(), next);
    await Promise.resolve();

    expect(handler).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('AppError', () => {
  it('classifies 4xx as a caller failure and 5xx as a server error', () => {
    expect(new AppError('bad request', 400).status).toBe('fail');
    expect(new AppError('broken', 500).status).toBe('error');
  });

  it('is operational, so the handler can tell it from a crash', () => {
    const error = new AppError('nope', 404);
    expect(error.isOperational).toBe(true);
    expect(error.statusCode).toBe(404);
    expect(error).toBeInstanceOf(Error);
  });
});
