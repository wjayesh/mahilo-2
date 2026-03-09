import { type DeclaredSelectors } from "./policy-helpers";
import type { MahiloPendingLearningSuggestion } from "./state";
type SendToolName = "talk_to_agent" | "talk_to_group";
export interface MahiloPostSendFailure {
    error: string;
    recipient: string;
    selectors: DeclaredSelectors;
    senderConnectionId?: string;
    toolName: SendToolName;
}
export interface MahiloPostSendObservation extends MahiloPendingLearningSuggestion {
}
export type MahiloPostSendEvent = {
    failure: MahiloPostSendFailure;
    kind: "failure";
} | {
    kind: "outcome";
    observation: MahiloPostSendObservation;
};
export declare function extractMahiloPostSendEvent(event: {
    error?: string;
    params: Record<string, unknown>;
    result?: unknown;
    toolName: string;
}): MahiloPostSendEvent | undefined;
export declare function formatMahiloOutcomeSystemEvent(event: MahiloPostSendEvent): string;
export declare function shouldQueueMahiloLearningSuggestion(observation: MahiloPostSendObservation): boolean;
export declare function formatMahiloLearningSuggestion(observation: MahiloPostSendObservation): string;
export {};
