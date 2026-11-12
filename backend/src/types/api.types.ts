import { Category, Stream, StreamType } from '@shared/types';

export interface LoginRequest {
  username: string;
  password: string;
  serverUrl?: string;
}

export interface LoginResponse {
  success: boolean;
  message?: string;
  data?: {
    /** Opaque session token; stands in for the credentials on every later call. */
    token: string;
    user_info: {
      username: string;
      message: string;
      auth: number;
      status: string;
      exp_date: string;
      is_trial: string;
      active_cons: string;
      created_at: string;
      max_connections: string;
      allowed_output_formats: string[];
    };
    server_info: {
      url: string;
      port: string;
      https_port: string;
      server_protocol: string;
      rtmp_port: string;
      timezone: string;
      timestamp_now: number;
      time_now: string;
    };
  };
}

export interface ErrorResponse {
  success: boolean;
  message: string;
  timestamp?: string;
}

export interface CategoryResponse {
  success: boolean;
  data?: Category[];
  message?: string;
}

export interface StreamsResponse {
  success: boolean;
  data?: Stream[];
  message?: string;
}

export interface SyncStatusResponse {
  success: boolean;
  data?: {
    type: StreamType;
    lastSync?: string;
    totalItems?: number;
    synced: boolean;
  };
  message?: string;
}

export interface SyncController {
  cancelled: boolean;
}
