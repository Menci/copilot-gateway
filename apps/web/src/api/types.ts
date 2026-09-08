import type { InferRequestType, InferResponseType } from 'hono/client';

import type { api } from './client';
import type { SerializedBackoffRow, SerializedProxyRecord } from '@floway-dev/gateway/control-plane/proxies/serialize';

export type {
  ClaudeCodeAccountCredentialSummary,
  ClaudeCodeQuotaSnapshotData,
  ClaudeCodeQuotaWindow,
  CodexAccountCredentialState,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotMap,
  CodexRateLimitResetCredit,
  CodexRateLimitResetCredits,
  CustomRawModel,
  ListUpstreamModelsResponse,
  UpstreamRecord,
} from '@floway-dev/gateway/control-plane/upstreams/types';

export type UpstreamRecordEnvelope = InferRequestType<
  typeof api.api.upstreams['list-models']['$post']
>['json']['record'];

export type ProxyRecord = SerializedProxyRecord;
export type BackoffRow = SerializedBackoffRow;

export type ApiKey = InferResponseType<typeof api.api.keys.$get, 200>[number];
export type ControlPlaneUser = InferResponseType<typeof api.api.users.$get, 200>[number];
export type UpstreamOption = InferResponseType<typeof api.api['upstream-options']['$get'], 200>[number];

export type ControlPlaneModel = InferResponseType<typeof api.api.models.$get, 200>['data'][number];
export type SearchConfig = InferResponseType<typeof api.api['search-config']['$get'], 200>;
export type CopilotQuotaSnapshot = InferResponseType<typeof api.api.upstreams.copilot.quota.$post, 200>;
export type OllamaUsageRefresh = InferResponseType<typeof api.api.upstreams.ollama.usage.$post, 200>;
export type DeviceFlowStart = InferResponseType<typeof api.api.upstreams.copilot.oauth['device-login']['start']['$post'], 200>;
export type BackupImportCounts = InferResponseType<typeof api.api.import.$post, 200>['imported'];
