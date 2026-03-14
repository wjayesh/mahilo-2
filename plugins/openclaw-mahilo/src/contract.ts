export const MAHILO_CONTRACT_VERSION = "1.0.0";

export const API_V1_BASE_PATH = "/api/v1";

export const CONTRACT_ENDPOINTS = {
  agents: `${API_V1_BASE_PATH}/agents`,
  directSendBundle: `${API_V1_BASE_PATH}/plugin/bundles/direct-send`,
  groupFanoutBundle: `${API_V1_BASE_PATH}/plugin/bundles/group-fanout`,
  contacts: `${API_V1_BASE_PATH}/contacts`,
  context: `${API_V1_BASE_PATH}/plugin/context`,
  friendRequest: `${API_V1_BASE_PATH}/friends/request`,
  friends: `${API_V1_BASE_PATH}/friends`,
  groups: `${API_V1_BASE_PATH}/groups`,
  resolve: `${API_V1_BASE_PATH}/plugin/resolve`,
  localDecisionCommit: `${API_V1_BASE_PATH}/plugin/local-decisions/commit`,
  sendMessage: `${API_V1_BASE_PATH}/messages/send`,
  outcomes: `${API_V1_BASE_PATH}/plugin/outcomes`,
  overrides: `${API_V1_BASE_PATH}/plugin/overrides`,
  reviews: `${API_V1_BASE_PATH}/plugin/reviews`,
  blockedEvents: `${API_V1_BASE_PATH}/plugin/events/blocked`,
} as const;

export type ContractEndpoint =
  (typeof CONTRACT_ENDPOINTS)[keyof typeof CONTRACT_ENDPOINTS];
