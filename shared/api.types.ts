import { StreamType, Stream, Category, SyncStatus, EPGProgram, SeriesInfo, Episode } from './types';

// Request/Response types for API endpoints
export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  details?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  serverUrl?: string;
}

export interface LoginResponse {
  success: boolean;
  data?: {
    user_info: {
      username: string;
      password: string;
      message: string;
      auth: number;
      status: string;
      exp_date: string;
      is_trial: string;
      active_cons: string;
      created_at: string;
      max_connections: string;
    };
    server_info?: Record<string, unknown>;
  };
  message?: string;
}

export interface SyncRequest {
  username: string;
  password: string;
  types?: StreamType[];
}

export interface SyncStatusResponse {
  synced: boolean;
  last_sync?: string;
  total_categories?: number;
  total_streams?: number;
  status?: string;
  message?: string;
  cancelled?: boolean;
}

export interface StreamsRequest {
  username: string;
  category_id: string;
  type: StreamType;
}

export interface SearchRequest {
  username: string;
  type: StreamType;
  query: string;
}

export interface SeriesInfoRequest {
  username: string;
  password: string;
  series_id: string;
}

export interface StreamInfoRequest {
  username: string;
  password: string;
  stream_id: string;
  type: StreamType;
}

export interface EPGRequest {
  username: string;
  password: string;
  stream_id: string;
}

export interface ExternalEPGRequest {
  epgUrl: string;
  channelId?: string;
}

export interface ExternalEPGProgramme {
  channel: string;
  start: string;
  stop: string;
  title: string;
  description: string;
  category?: string;
}

export interface ExternalEPGChannel {
  id: string;
  name: string;
}

export interface ExternalEPGData {
  channels: ExternalEPGChannel[];
  programmes: ExternalEPGProgramme[];
  total: number;
}

export interface ExternalEPGResponse extends ApiResponse<ExternalEPGData> {
  data: ExternalEPGData;
}

// Database types
export interface DatabaseStream extends Omit<Stream, 'stream_id'> {
  stream_id: number;
  category_id: string;
  type: StreamType;
  username: string;
}

export interface DatabaseCategory extends Category {
  type: StreamType;
  username: string;
}

// XMLTV types
export interface XMLTVChannel {
  '@_id': string;
  'display-name': string | string[] | { '#text': string };
}

export interface XMLTVProgramme {
  '@_channel': string;
  '@_start': string;
  '@_stop': string;
  title: string | { '#text': string };
  desc?: string | { '#text': string };
  category?: string | string[] | { '#text': string };
}

export interface XMLTV {
  tv: {
    channel?: XMLTVChannel | XMLTVChannel[];
    programme?: XMLTVProgramme | XMLTVProgramme[];
  };
}
