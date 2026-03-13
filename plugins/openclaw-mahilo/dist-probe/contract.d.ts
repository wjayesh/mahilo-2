export declare const MAHILO_CONTRACT_VERSION = "1.0.0";
export declare const API_V1_BASE_PATH = "/api/v1";
export declare const CONTRACT_ENDPOINTS: {
    readonly context: "/api/v1/plugin/context";
    readonly resolve: "/api/v1/plugin/resolve";
    readonly sendMessage: "/api/v1/messages/send";
    readonly outcomes: "/api/v1/plugin/outcomes";
    readonly overrides: "/api/v1/plugin/overrides";
    readonly reviews: "/api/v1/plugin/reviews";
    readonly blockedEvents: "/api/v1/plugin/events/blocked";
};
export type ContractEndpoint = (typeof CONTRACT_ENDPOINTS)[keyof typeof CONTRACT_ENDPOINTS];
