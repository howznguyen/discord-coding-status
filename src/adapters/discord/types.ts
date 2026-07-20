'use strict';

export interface RpcConnectionState {
  client: any | null;
  ready: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connecting: Promise<void> | null;
  activeToolKey: string | null;
  activityStartedAt: Date | null;
  lastSentActivitySignature: string | null;
  lastCleared: boolean;
  connectionAttempt: number;
}
