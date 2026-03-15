import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  readDualSandboxConnectedRunFromRunRoot,
  redactConnectedRunSummary,
  type DualSandboxConnectedRunSummary,
} from "./dual-sandbox-connections-lib";

export const DUAL_SANDBOX_RELATIONSHIP_CONTRACT_VERSION = 1;

type SandboxId = "a" | "b";

interface ResolvedGroupOptions {
  description: string | null;
  inviteOnly: boolean;
  name: string;
  setup: boolean;
}

interface FriendRequestResponse {
  friendship_id?: string;
  status?: string;
}

interface FriendshipRolesResponse {
  roles?: unknown;
}

interface FriendsListResponse {
  friends?: unknown;
}

interface GroupCreateResponse {
  description?: string | null;
  group_id?: string;
  invite_only?: boolean;
  name?: string;
  role?: string;
}

interface GroupInviteResponse {
  group_id?: string;
  membership_id?: string;
  status?: string;
  username?: string;
}

interface GroupJoinResponse {
  group_id?: string;
  name?: string;
  role?: string;
  status?: string;
}

interface RoleCreateResponse {
  description?: string | null;
  id?: string;
  is_system?: boolean;
  name?: string;
}

interface RolesListResponse {
  roles?: unknown;
}

interface RoleAssignmentResponse {
  role?: string;
  success?: boolean;
}

interface AvailableRoleRecord {
  is_system: boolean;
  name: string;
}

const DEFAULT_FRIENDSHIP_ROLES: string[] = [];
const DEFAULT_GROUP_DESCRIPTION_PREFIX = "Mahilo dual-sandbox harness group";
const DEFAULT_GROUP_INVITE_ONLY = true;
const DEFAULT_GROUP_NAME_PREFIX = "sandbox-harness";
const FRIENDSHIP_SUMMARY_FILE_NAME = "friendship-summary.json";

export interface DualSandboxRelationshipGroupOptions {
  description?: string;
  inviteOnly?: boolean;
  name?: string;
  setup?: boolean;
}

export interface DualSandboxRelationshipOptions {
  fetchImpl?: typeof fetch;
  friendshipRoles?: string[];
  group?: DualSandboxRelationshipGroupOptions;
  mahiloBaseUrl?: string;
  now?: () => Date;
}

export interface DualSandboxRelationshipParticipantSummary {
  callback_url: string;
  connection_id: string;
  sandbox_id: SandboxId;
  user_id: string;
  username: string;
}

export interface DualSandboxFriendRecordSummary {
  direction: "received" | "sent";
  display_name: string | null;
  friendship_id: string;
  roles: string[];
  status: string;
  user_id: string;
  username: string;
}

export interface DualSandboxFriendshipNetworkViewSummary {
  friends: DualSandboxFriendRecordSummary[];
  status_code: number;
}

export interface DualSandboxFriendshipRequestSummary {
  friendship_id: string;
  requested_by_sandbox: SandboxId;
  requested_username: string;
  status: "accepted" | "pending";
  status_code: number;
}

export interface DualSandboxFriendshipAcceptSummary {
  accepted_by_sandbox: SandboxId;
  friendship_id: string;
  handled_by: "explicit_accept" | "request_auto_accept";
  status: "accepted";
  status_code: number | null;
}

export interface DualSandboxFriendshipRoleAssignmentSummary {
  available_before_assignment: boolean;
  create_role_status_code: number | null;
  created_custom_role: boolean;
  role: string;
  role_source: "custom" | "system";
  status_code: number;
}

export interface DualSandboxFriendshipRolesSummary {
  assigned: string[];
  assignments: DualSandboxFriendshipRoleAssignmentSummary[];
  get_available_roles_status_code: number | null;
  get_friendship_roles_status_code: number;
}

export interface DualSandboxFriendshipSummary {
  accept: DualSandboxFriendshipAcceptSummary;
  accepted: true;
  friendship_id: string;
  network_views: {
    a: DualSandboxFriendshipNetworkViewSummary;
    b: DualSandboxFriendshipNetworkViewSummary;
  };
  request: DualSandboxFriendshipRequestSummary;
  roles: DualSandboxFriendshipRolesSummary;
}

export interface DualSandboxGroupListEntrySummary {
  group_id: string;
  invite_only: boolean;
  member_count: number;
  name: string;
  role: string;
  status: string;
}

export interface DualSandboxGroupMemberSummary {
  display_name: string | null;
  membership_id: string;
  role: string;
  status: string;
  user_id: string;
  username: string;
}

export interface DualSandboxGroupSetupSummary {
  create_status_code: number;
  created_by_sandbox: SandboxId;
  description: string | null;
  group_id: string;
  invite_only: boolean;
  invite_status_code: number;
  invited_membership_id: string;
  invited_username: string;
  join_role: string;
  join_status: string;
  join_status_code: number;
  member_groups: DualSandboxGroupListEntrySummary[];
  member_groups_status_code: number;
  members: DualSandboxGroupMemberSummary[];
  members_status_code: number;
  name: string;
  owner_groups: DualSandboxGroupListEntrySummary[];
  owner_groups_status_code: number;
}

export interface DualSandboxRelationshipSummary {
  contract_version: number;
  created_at: string;
  current_phase: "relationships";
  friendship: DualSandboxFriendshipSummary;
  group: DualSandboxGroupSetupSummary | null;
  mahilo_base_url: string;
  participants: {
    receiver: DualSandboxRelationshipParticipantSummary;
    sender: DualSandboxRelationshipParticipantSummary;
  };
}

export interface DualSandboxRelationshipRunSummary
  extends DualSandboxConnectedRunSummary {
  relationships: DualSandboxRelationshipSummary;
}

export async function setupDualSandboxRelationships(
  summary: DualSandboxConnectedRunSummary,
  options: DualSandboxRelationshipOptions = {},
): Promise<DualSandboxRelationshipRunSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const mahiloBaseUrl = normalizeBaseUrl(
    options.mahiloBaseUrl ?? summary.connections.mahilo_base_url,
  );
  const friendshipRoles = normalizeFriendshipRoles(options.friendshipRoles);
  const groupOptions = resolveGroupOptions(options.group, summary.run_id);
  const sender = buildParticipant(summary, "a");
  const receiver = buildParticipant(summary, "b");
  const senderApiKey = summary.provisioning.sandboxes.a.api_key;
  const receiverApiKey = summary.provisioning.sandboxes.b.api_key;

  const friendshipRequest = await requestJson<FriendRequestResponse>(
    fetchImpl,
    mahiloBaseUrl,
    {
      bearerToken: senderApiKey,
      body: {
        username: receiver.username,
      },
      method: "POST",
      path: "/api/v1/friends/request",
    },
  );

  const friendshipId = readString(friendshipRequest.json.friendship_id);
  const friendshipStatus = readString(friendshipRequest.json.status);
  if (
    !friendshipId ||
    (friendshipStatus !== "pending" && friendshipStatus !== "accepted")
  ) {
    throw new Error(
      "Friend request did not return a valid friendship_id and status.",
    );
  }

  let friendshipAccept: DualSandboxFriendshipAcceptSummary = {
    accepted_by_sandbox: "b",
    friendship_id: friendshipId,
    handled_by: "request_auto_accept",
    status: "accepted",
    status_code: null,
  };

  if (friendshipStatus === "pending") {
    const acceptResponse = await requestJson<FriendRequestResponse>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: receiverApiKey,
        method: "POST",
        path: `/api/v1/friends/${friendshipId}/accept`,
      },
    );
    const acceptedFriendshipId = readString(acceptResponse.json.friendship_id);
    const acceptedStatus = readString(acceptResponse.json.status);
    if (acceptedFriendshipId !== friendshipId || acceptedStatus !== "accepted") {
      throw new Error(
        `Friend request acceptance for ${friendshipId} returned an unexpected response.`,
      );
    }

    friendshipAccept = {
      accepted_by_sandbox: "b",
      friendship_id: friendshipId,
      handled_by: "explicit_accept",
      status: "accepted",
      status_code: acceptResponse.status,
    };
  }

  let availableRolesStatusCode: number | null = null;
  const roleAssignments: DualSandboxFriendshipRoleAssignmentSummary[] = [];

  if (friendshipRoles.length > 0) {
    const availableRoles = await requestJson<RolesListResponse>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: senderApiKey,
        method: "GET",
        path: "/api/v1/roles",
      },
    );
    availableRolesStatusCode = availableRoles.status;
    const roleMap = readAvailableRoles(availableRoles.json.roles);

    for (const role of friendshipRoles) {
      const availableRole = roleMap.get(role);
      let createRoleStatusCode: number | null = null;
      let createdCustomRole = false;
      let roleSource: "custom" | "system" = availableRole?.is_system
        ? "system"
        : "custom";

      if (!availableRole) {
        const createRole = await requestJson<RoleCreateResponse>(
          fetchImpl,
          mahiloBaseUrl,
          {
            bearerToken: senderApiKey,
            body: {
              description: `Mahilo dual-sandbox harness role ${role}`,
              name: role,
            },
            method: "POST",
            path: "/api/v1/roles",
          },
        );
        const createdRoleName = readString(createRole.json.name);
        if (createdRoleName !== role) {
          throw new Error(`Role creation for ${role} returned an unexpected name.`);
        }
        createRoleStatusCode = createRole.status;
        createdCustomRole = true;
        roleSource = "custom";
        roleMap.set(role, {
          is_system: false,
          name: role,
        });
      }

      const assignRole = await requestJson<RoleAssignmentResponse>(
        fetchImpl,
        mahiloBaseUrl,
        {
          bearerToken: senderApiKey,
          body: {
            role,
          },
          method: "POST",
          path: `/api/v1/friends/${friendshipId}/roles`,
        },
      );
      if (assignRole.json.success !== true || assignRole.json.role !== role) {
        throw new Error(
          `Friendship role assignment for ${role} returned an unexpected response.`,
        );
      }

      roleAssignments.push({
        available_before_assignment: availableRole !== undefined,
        create_role_status_code: createRoleStatusCode,
        created_custom_role: createdCustomRole,
        role,
        role_source: roleSource,
        status_code: assignRole.status,
      });
    }
  }

  const friendshipRolesResponse = await requestJson<FriendshipRolesResponse>(
    fetchImpl,
    mahiloBaseUrl,
    {
      bearerToken: senderApiKey,
      method: "GET",
      path: `/api/v1/friends/${friendshipId}/roles`,
    },
  );
  const assignedRoles = readStringArray(friendshipRolesResponse.json.roles);

  for (const role of friendshipRoles) {
    if (!assignedRoles.includes(role)) {
      throw new Error(
        `Friendship ${friendshipId} is missing assigned role ${role} in the final role list.`,
      );
    }
  }

  const senderNetworkView = await requestJson<FriendsListResponse>(
    fetchImpl,
    mahiloBaseUrl,
    {
      bearerToken: senderApiKey,
      method: "GET",
      path: "/api/v1/friends?status=accepted",
    },
  );
  const receiverNetworkView = await requestJson<FriendsListResponse>(
    fetchImpl,
    mahiloBaseUrl,
    {
      bearerToken: receiverApiKey,
      method: "GET",
      path: "/api/v1/friends?status=accepted",
    },
  );
  const senderFriends = readFriends(senderNetworkView.json.friends);
  const receiverFriends = readFriends(receiverNetworkView.json.friends);
  assertFriendshipVisible({
    expectedDirection: "sent",
    expectedFriendshipId: friendshipId,
    expectedStatus: "accepted",
    expectedUserId: receiver.user_id,
    friends: senderFriends,
    sandboxId: "a",
  });
  assertFriendshipVisible({
    expectedDirection: "received",
    expectedFriendshipId: friendshipId,
    expectedStatus: "accepted",
    expectedUserId: sender.user_id,
    friends: receiverFriends,
    sandboxId: "b",
  });

  let groupSummary: DualSandboxGroupSetupSummary | null = null;

  if (groupOptions.setup) {
    const createGroup = await requestJson<GroupCreateResponse>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: senderApiKey,
        body: {
          description: groupOptions.description ?? undefined,
          invite_only: groupOptions.inviteOnly,
          name: groupOptions.name,
        },
        method: "POST",
        path: "/api/v1/groups",
      },
    );
    const groupId = readString(createGroup.json.group_id);
    const groupName = readString(createGroup.json.name);
    if (!groupId || groupName !== groupOptions.name) {
      throw new Error("Group creation returned an unexpected group payload.");
    }

    const groupInvite = await requestJson<GroupInviteResponse>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: senderApiKey,
        body: {
          username: receiver.username,
        },
        method: "POST",
        path: `/api/v1/groups/${groupId}/invite`,
      },
    );
    const invitedMembershipId = readString(groupInvite.json.membership_id);
    const invitedUsername = readString(groupInvite.json.username);
    const invitedStatus = readString(groupInvite.json.status);
    if (
      !invitedMembershipId ||
      invitedUsername !== receiver.username ||
      invitedStatus !== "invited"
    ) {
      throw new Error(`Group invite for ${groupId} returned an unexpected response.`);
    }

    const groupJoin = await requestJson<GroupJoinResponse>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: receiverApiKey,
        method: "POST",
        path: `/api/v1/groups/${groupId}/join`,
      },
    );
    const joinRole = readString(groupJoin.json.role);
    const joinStatus = readString(groupJoin.json.status);
    if (
      groupJoin.json.group_id !== groupId ||
      groupJoin.json.name !== groupOptions.name ||
      !joinRole ||
      joinStatus !== "active"
    ) {
      throw new Error(`Group join for ${groupId} returned an unexpected response.`);
    }

    const groupMembersResponse = await requestJson<unknown[]>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: senderApiKey,
        method: "GET",
        path: `/api/v1/groups/${groupId}/members`,
      },
    );
    const groupMembers = readGroupMembers(groupMembersResponse.json);
    assertGroupMember({
      expectedRole: "owner",
      expectedStatus: "active",
      expectedUserId: sender.user_id,
      groupId,
      members: groupMembers,
      username: sender.username,
    });
    assertGroupMember({
      expectedRole: "member",
      expectedStatus: "active",
      expectedUserId: receiver.user_id,
      groupId,
      members: groupMembers,
      username: receiver.username,
    });

    const ownerGroupsResponse = await requestJson<unknown[]>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: senderApiKey,
        method: "GET",
        path: "/api/v1/groups",
      },
    );
    const memberGroupsResponse = await requestJson<unknown[]>(
      fetchImpl,
      mahiloBaseUrl,
      {
        bearerToken: receiverApiKey,
        method: "GET",
        path: "/api/v1/groups",
      },
    );
    const ownerGroups = readGroupList(ownerGroupsResponse.json);
    const memberGroups = readGroupList(memberGroupsResponse.json);
    assertGroupListed({
      expectedGroupId: groupId,
      expectedInviteOnly: groupOptions.inviteOnly,
      expectedRole: "owner",
      expectedStatus: "active",
      groups: ownerGroups,
      sandboxId: "a",
    });
    assertGroupListed({
      expectedGroupId: groupId,
      expectedInviteOnly: groupOptions.inviteOnly,
      expectedRole: "member",
      expectedStatus: "active",
      groups: memberGroups,
      sandboxId: "b",
    });

    groupSummary = {
      create_status_code: createGroup.status,
      created_by_sandbox: "a",
      description: groupOptions.description,
      group_id: groupId,
      invite_only: groupOptions.inviteOnly,
      invite_status_code: groupInvite.status,
      invited_membership_id: invitedMembershipId,
      invited_username: invitedUsername,
      join_role: joinRole,
      join_status: joinStatus,
      join_status_code: groupJoin.status,
      member_groups: memberGroups,
      member_groups_status_code: memberGroupsResponse.status,
      members: groupMembers,
      members_status_code: groupMembersResponse.status,
      name: groupOptions.name,
      owner_groups: ownerGroups,
      owner_groups_status_code: ownerGroupsResponse.status,
    };
  }

  const relationships: DualSandboxRelationshipSummary = {
    contract_version: DUAL_SANDBOX_RELATIONSHIP_CONTRACT_VERSION,
    created_at: createdAt,
    current_phase: "relationships",
    friendship: {
      accept: friendshipAccept,
      accepted: true,
      friendship_id: friendshipId,
      network_views: {
        a: {
          friends: senderFriends,
          status_code: senderNetworkView.status,
        },
        b: {
          friends: receiverFriends,
          status_code: receiverNetworkView.status,
        },
      },
      request: {
        friendship_id: friendshipId,
        requested_by_sandbox: "a",
        requested_username: receiver.username,
        status: friendshipStatus,
        status_code: friendshipRequest.status,
      },
      roles: {
        assigned: assignedRoles,
        assignments: roleAssignments,
        get_available_roles_status_code: availableRolesStatusCode,
        get_friendship_roles_status_code: friendshipRolesResponse.status,
      },
    },
    group: groupSummary,
    mahilo_base_url: mahiloBaseUrl,
    participants: {
      receiver,
      sender,
    },
  };

  const relationshipSummary: DualSandboxRelationshipRunSummary = {
    ...summary,
    provisioning: {
      ...summary.provisioning,
      current_phase: "relationships",
    },
    relationships,
  };

  writeJsonFile(summary.paths.runtime_provisioning_path, relationshipSummary);
  writeJsonFile(
    summary.paths.artifact_bootstrap_summary_path,
    redactRelationshipRunSummary(relationshipSummary),
  );
  writeJsonFile(
    join(summary.paths.provisioning_dir, FRIENDSHIP_SUMMARY_FILE_NAME),
    relationships,
  );

  return relationshipSummary;
}

export function redactRelationshipRunSummary(
  summary: DualSandboxRelationshipRunSummary,
): DualSandboxRelationshipRunSummary {
  return {
    ...(redactConnectedRunSummary(summary) as DualSandboxRelationshipRunSummary),
    relationships: summary.relationships,
  };
}

export function readDualSandboxRelationshipRunFromRunRoot(
  runRoot: string,
): DualSandboxRelationshipRunSummary {
  const connectedRun = readDualSandboxConnectedRunFromRunRoot(runRoot);
  const runtimeProvisioningPath = connectedRun.paths.runtime_provisioning_path;
  const parsed = readJsonFile<Partial<DualSandboxRelationshipRunSummary>>(
    runtimeProvisioningPath,
  );

  assertRelationshipRunSummary(parsed, runtimeProvisioningPath);
  return parsed;
}

function assertRelationshipRunSummary(
  parsed: Partial<DualSandboxRelationshipRunSummary>,
  runtimeProvisioningPath: string,
): asserts parsed is DualSandboxRelationshipRunSummary {
  const relationships = readRecord(
    (parsed as Record<string, unknown>).relationships,
  );
  const participants = readRecord(relationships.participants);
  const sender = readRecord(participants.sender);
  const receiver = readRecord(participants.receiver);
  const friendship = readRecord(relationships.friendship);

  if (
    typeof relationships.contract_version !== "number" ||
    !Number.isFinite(relationships.contract_version) ||
    !readString(relationships.created_at) ||
    relationships.current_phase !== "relationships" ||
    !readString(relationships.mahilo_base_url) ||
    friendship.accepted !== true
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid dual-sandbox relationship summary.`,
    );
  }

  assertParticipant(sender, "sender", runtimeProvisioningPath);
  assertParticipant(receiver, "receiver", runtimeProvisioningPath);
  assertFriendshipSummary(friendship, runtimeProvisioningPath);

  const friendshipArtifactPath = join(
    resolve(parsed.run_root ?? ""),
    "artifacts",
    "provisioning",
    FRIENDSHIP_SUMMARY_FILE_NAME,
  );
  if (!existsSync(friendshipArtifactPath)) {
    throw new Error(
      `Expected relationship artifact at ${friendshipArtifactPath} referenced by ${runtimeProvisioningPath}.`,
    );
  }
}

function assertParticipant(
  participant: Record<string, unknown>,
  label: string,
  runtimeProvisioningPath: string,
): void {
  if (
    !readString(participant.callback_url) ||
    !readString(participant.connection_id) ||
    !isSandboxId(participant.sandbox_id) ||
    !readString(participant.user_id) ||
    !readString(participant.username)
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid ${label} participant summary.`,
    );
  }
}

function assertFriendshipSummary(
  friendship: Record<string, unknown>,
  runtimeProvisioningPath: string,
): void {
  const request = readRecord(friendship.request);
  const accept = readRecord(friendship.accept);
  const roles = readRecord(friendship.roles);
  const networkViews = readRecord(friendship.network_views);
  const senderView = readRecord(networkViews.a);
  const receiverView = readRecord(networkViews.b);

  if (
    !readString(friendship.friendship_id) ||
    request.status !== "pending" && request.status !== "accepted" ||
    !readString(request.friendship_id) ||
    !isSandboxId(request.requested_by_sandbox) ||
    !readString(request.requested_username) ||
    typeof request.status_code !== "number" ||
    accept.status !== "accepted" ||
    !readString(accept.friendship_id) ||
    !isSandboxId(accept.accepted_by_sandbox) ||
    (accept.handled_by !== "explicit_accept" &&
      accept.handled_by !== "request_auto_accept") ||
    (accept.status_code !== null &&
      (typeof accept.status_code !== "number" ||
        !Number.isFinite(accept.status_code))) ||
    !Array.isArray(roles.assigned) ||
    !Array.isArray(roles.assignments) ||
    typeof roles.get_friendship_roles_status_code !== "number" ||
    !Number.isFinite(roles.get_friendship_roles_status_code) ||
    (roles.get_available_roles_status_code !== null &&
      (typeof roles.get_available_roles_status_code !== "number" ||
        !Number.isFinite(roles.get_available_roles_status_code))) ||
    !Array.isArray(senderView.friends) ||
    !Array.isArray(receiverView.friends) ||
    typeof senderView.status_code !== "number" ||
    !Number.isFinite(senderView.status_code) ||
    typeof receiverView.status_code !== "number" ||
    !Number.isFinite(receiverView.status_code)
  ) {
    throw new Error(
      `File ${runtimeProvisioningPath} does not contain a valid dual-sandbox friendship summary.`,
    );
  }
}

function buildParticipant(
  summary: DualSandboxConnectedRunSummary,
  sandboxId: SandboxId,
): DualSandboxRelationshipParticipantSummary {
  const sandboxConnection = summary.connections.sandboxes[sandboxId];
  const sandboxProvisioning = summary.provisioning.sandboxes[sandboxId];

  return {
    callback_url: sandboxConnection.callback_url,
    connection_id: sandboxConnection.connection_id,
    sandbox_id: sandboxId,
    user_id: sandboxProvisioning.user_id,
    username: sandboxProvisioning.username,
  };
}

function assertFriendshipVisible(input: {
  expectedDirection: "received" | "sent";
  expectedFriendshipId: string;
  expectedStatus: string;
  expectedUserId: string;
  friends: DualSandboxFriendRecordSummary[];
  sandboxId: SandboxId;
}): void {
  const match = input.friends.find(
    (friend) =>
      friend.friendship_id === input.expectedFriendshipId &&
      friend.user_id === input.expectedUserId,
  );
  if (
    !match ||
    match.status !== input.expectedStatus ||
    match.direction !== input.expectedDirection
  ) {
    throw new Error(
      `Sandbox ${input.sandboxId} did not list friendship ${input.expectedFriendshipId} with the expected accepted view.`,
    );
  }
}

function assertGroupListed(input: {
  expectedGroupId: string;
  expectedInviteOnly: boolean;
  expectedRole: string;
  expectedStatus: string;
  groups: DualSandboxGroupListEntrySummary[];
  sandboxId: SandboxId;
}): void {
  const match = input.groups.find(
    (group) => group.group_id === input.expectedGroupId,
  );
  if (
    !match ||
    match.invite_only !== input.expectedInviteOnly ||
    match.role !== input.expectedRole ||
    match.status !== input.expectedStatus
  ) {
    throw new Error(
      `Sandbox ${input.sandboxId} did not list group ${input.expectedGroupId} with the expected membership state.`,
    );
  }
}

function assertGroupMember(input: {
  expectedRole: string;
  expectedStatus: string;
  expectedUserId: string;
  groupId: string;
  members: DualSandboxGroupMemberSummary[];
  username: string;
}): void {
  const match = input.members.find(
    (member) => member.user_id === input.expectedUserId,
  );
  if (
    !match ||
    match.role !== input.expectedRole ||
    match.status !== input.expectedStatus ||
    match.username !== input.username
  ) {
    throw new Error(
      `Group ${input.groupId} is missing active member ${input.username} with role ${input.expectedRole}.`,
    );
  }
}

function resolveGroupOptions(
  group: DualSandboxRelationshipGroupOptions | undefined,
  runId: string,
): ResolvedGroupOptions {
  const setup = group?.setup ?? true;

  if (!setup) {
    if (group?.name || group?.description || group?.inviteOnly !== undefined) {
      throw new Error(
        "group.name, group.description, and group.inviteOnly require group.setup=true.",
      );
    }

    return {
      description: null,
      inviteOnly: DEFAULT_GROUP_INVITE_ONLY,
      name: "",
      setup: false,
    };
  }

  const name = normalizeGroupName(
    group?.name ??
      `${DEFAULT_GROUP_NAME_PREFIX}-${runId.toLowerCase()}`.replace(
        /[^a-z0-9_-]/g,
        "-",
      ),
  );

  return {
    description: normalizeOptionalString(
      group?.description ?? `${DEFAULT_GROUP_DESCRIPTION_PREFIX} ${runId}`,
    ),
    inviteOnly: group?.inviteOnly ?? DEFAULT_GROUP_INVITE_ONLY,
    name,
    setup: true,
  };
}

function normalizeGroupName(name: string): string {
  const normalized = normalizeRequiredString(name, "group.name");
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(
      "group.name must contain only alphanumeric characters, underscores, and hyphens.",
    );
  }
  if (normalized.length > 100) {
    throw new Error("group.name must be 100 characters or fewer.");
  }

  return normalized;
}

function normalizeFriendshipRoles(roles: string[] | undefined): string[] {
  const values = roles ?? DEFAULT_FRIENDSHIP_ROLES;
  const deduped = new Set<string>();

  for (const role of values) {
    const normalized = normalizeRequiredString(role, "friendshipRoles entry");
    deduped.add(normalized);
  }

  return [...deduped];
}

async function requestJson<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: {
    bearerToken?: string;
    body?: unknown;
    method: "GET" | "POST";
    path: string;
  },
): Promise<{
  json: T;
  status: number;
}> {
  const response = await fetchImpl(
    new URL(options.path, `${baseUrl}/`).toString(),
    {
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        ...(options.body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
            }),
        ...(options.bearerToken
          ? {
              Authorization: `Bearer ${options.bearerToken}`,
            }
          : {}),
      },
      method: options.method,
    },
  );

  const responseText = await response.text();
  const parsedJson = parseJsonResponse(responseText);

  if (!response.ok) {
    throw new Error(
      `${options.method} ${options.path} failed with ${response.status}: ${readErrorMessage(
        parsedJson,
        responseText,
      )}`,
    );
  }

  if (parsedJson === null) {
    throw new Error(
      `${options.method} ${options.path} returned an empty or non-JSON response.`,
    );
  }

  return {
    json: parsedJson as T,
    status: response.status,
  };
}

function readAvailableRoles(value: unknown): Map<string, AvailableRoleRecord> {
  if (!Array.isArray(value)) {
    return new Map();
  }

  return new Map(
    value
      .map((entry) => {
        const record = readRecord(entry);
        const name = readString(record.name);
        const isSystem = record.is_system;

        if (!name || typeof isSystem !== "boolean") {
          return null;
        }

        return [
          name,
          {
            is_system: isSystem,
            name,
          } satisfies AvailableRoleRecord,
        ] as const;
      })
      .filter(
        (
          entry,
        ): entry is readonly [string, AvailableRoleRecord] => entry !== null,
      ),
  );
}

function readFriends(value: unknown): DualSandboxFriendRecordSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = readRecord(entry);
      const direction = record.direction;
      const friendshipId = readString(record.friendship_id);
      const status = readString(record.status);
      const userId = readString(record.user_id);
      const username = readString(record.username);

      if (
        !friendshipId ||
        !status ||
        !userId ||
        !username ||
        (direction !== "received" && direction !== "sent")
      ) {
        return null;
      }

      return {
        direction,
        display_name: readString(record.display_name),
        friendship_id: friendshipId,
        roles: readStringArray(record.roles),
        status,
        user_id: userId,
        username,
      } satisfies DualSandboxFriendRecordSummary;
    })
    .filter((entry): entry is DualSandboxFriendRecordSummary => entry !== null);
}

function readGroupList(value: unknown): DualSandboxGroupListEntrySummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = readRecord(entry);
      const groupId = readString(record.group_id);
      const name = readString(record.name);
      const role = readString(record.role);
      const status = readString(record.status);
      const memberCount = record.member_count;
      const inviteOnly = record.invite_only;

      if (
        !groupId ||
        !name ||
        !role ||
        !status ||
        typeof memberCount !== "number" ||
        !Number.isFinite(memberCount) ||
        typeof inviteOnly !== "boolean"
      ) {
        return null;
      }

      return {
        group_id: groupId,
        invite_only: inviteOnly,
        member_count: memberCount,
        name,
        role,
        status,
      } satisfies DualSandboxGroupListEntrySummary;
    })
    .filter(
      (entry): entry is DualSandboxGroupListEntrySummary => entry !== null,
    );
}

function readGroupMembers(value: unknown): DualSandboxGroupMemberSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      const record = readRecord(entry);
      const membershipId = readString(record.membership_id);
      const role = readString(record.role);
      const status = readString(record.status);
      const userId = readString(record.user_id);
      const username = readString(record.username);

      if (!membershipId || !role || !status || !userId || !username) {
        return null;
      }

      return {
        display_name: readString(record.display_name),
        membership_id: membershipId,
        role,
        status,
        user_id: userId,
        username,
      } satisfies DualSandboxGroupMemberSummary;
    })
    .filter((entry): entry is DualSandboxGroupMemberSummary => entry !== null);
}

function parseJsonResponse(responseText: string): unknown | null {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readErrorMessage(parsedJson: unknown, responseText: string): string {
  if (typeof parsedJson === "object" && parsedJson !== null) {
    const message = readString((parsedJson as Record<string, unknown>).message);
    if (message) {
      return message;
    }

    const errorRecord = readRecord(
      (parsedJson as Record<string, unknown>).error,
    );
    const nestedMessage = readString(errorRecord.message);
    if (nestedMessage) {
      return nestedMessage;
    }

    const code = readString(errorRecord.code);
    if (code) {
      return code;
    }
  }

  return responseText.trim() || "Request failed";
}

function normalizeBaseUrl(baseUrl: string): string {
  return normalizeRequiredString(baseUrl, "mahiloBaseUrl").replace(/\/+$/, "");
}

function isSandboxId(value: unknown): value is SandboxId {
  return value === "a" || value === "b";
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => {
    return typeof entry === "string" && entry.trim().length > 0;
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), {
    recursive: true,
  });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
