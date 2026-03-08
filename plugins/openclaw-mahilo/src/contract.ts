export const MAHILO_CONTRACT_VERSION = "1.0.0";

export const API_V1_BASE_PATH = "/api/v1";

export const CONTRACT_ENDPOINTS = {
  context: `${API_V1_BASE_PATH}/plugin/context`,
  resolve: `${API_V1_BASE_PATH}/plugin/resolve`,
  sendMessage: `${API_V1_BASE_PATH}/messages/send`,
  outcomes: `${API_V1_BASE_PATH}/plugin/outcomes`,
  overrides: `${API_V1_BASE_PATH}/plugin/overrides`,
  reviews: `${API_V1_BASE_PATH}/plugin/reviews`,
  blockedEvents: `${API_V1_BASE_PATH}/plugin/events/blocked`
} as const;

export type ContractEndpoint = (typeof CONTRACT_ENDPOINTS)[keyof typeof CONTRACT_ENDPOINTS];
