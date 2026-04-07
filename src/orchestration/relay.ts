import type { SendMessageResult } from '../types.js';

export interface RelayResult {
  from: string;
  to: string;
  message: string;
  sendResult: SendMessageResult;
}

export interface BroadcastTargetResult {
  to: string;
  ok: boolean;
  error?: string;
  sendResult?: SendMessageResult;
}

export interface BroadcastResult {
  from: string;
  targets: string[];
  message: string;
  results: BroadcastTargetResult[];
}
