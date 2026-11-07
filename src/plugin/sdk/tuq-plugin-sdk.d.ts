declare module '@teamuq/plugin-sdk' {
export const PLUGIN_PROGRAM_PERMISSION_SCOPES_V1: Readonly<{ readonly 'program:conversation:dispatch': "conversation:dispatch"; readonly 'program:conversation:read': "conversation:read"; readonly 'program:conversation:followup': "conversation:followup"; readonly 'program:data:projects:read': "data:projects:read"; readonly 'program:data:projects:write': "data:projects:write"; readonly 'program:data:milestones:read': "data:milestones:read"; readonly 'program:data:milestones:write': "data:milestones:write"; readonly 'program:data:tasks:read': "data:tasks:read"; readonly 'program:data:tasks:write': "data:tasks:write"; readonly 'program:data:tasks:status': "data:tasks:status"; }>
export const PLUGIN_PROGRAM_PERMISSION_OPERATIONS_V1: Readonly<{ readonly 'program:conversation:dispatch': readonly ["conversation.dispatch"]; readonly 'program:conversation:read': readonly ["conversation.read"]; readonly 'program:conversation:followup': readonly ["conversation.followUp"]; readonly 'program:data:projects:read': readonly ["data.projects.list", "data.projects.get"]; readonly 'program:data:projects:write': readonly ["data.projects.create", "data.projects.update", "data.projects.delete"]; readonly 'program:data:milestones:read': readonly ["data.milestones.list", "data.milestones.get"]; readonly 'program:data:milestones:write': readonly ["data.milestones.create", "data.milestones.update", "data.milestones.delete"]; readonly 'program:data:tasks:read': readonly ["data.tasks.list", "data.tasks.get"]; readonly 'program:data:tasks:write': readonly ["data.tasks.create", "data.tasks.update", "data.tasks.delete"]; readonly 'program:data:tasks:status': readonly ["data.tasks.update"]; }>
export const PLUGIN_PROGRAM_API_CHANNELS_V1: Readonly<{ REQUEST: "plugin-view:program-api"; }>
export const PLUGIN_PROGRAM_OPERATION_NAMES_V1: readonly ["program.describe", "conversation.dispatch", "conversation.read", "conversation.followUp", "data.projects.list", "data.projects.get", "data.projects.create", "data.projects.update", "data.projects.delete", "data.milestones.list", "data.milestones.get", "data.milestones.create", "data.milestones.update", "data.milestones.delete", "data.tasks.list", "data.tasks.get", "data.tasks.create", "data.tasks.update", "data.tasks.delete"]
export const PLUGIN_PROGRAM_SCOPE_NAMES_V1: readonly ["admin", "conversation:dispatch", "conversation:read", "conversation:followup", "data:projects:read", "data:projects:write", "data:milestones:read", "data:milestones:write", "data:tasks:read", "data:tasks:write", "data:tasks:status", "none"]
export interface PluginStoreApiV1 {
    status(options?: Readonly<{
        refresh?: boolean;
    }>): Promise<PluginStoreStatusViewV1>;
    list(query?: PluginStoreListQueryV1): Promise<PluginStoreListViewV1>;
    get(entryId: string): Promise<PluginStoreEntryDetailViewV1 | null>;
    preflight(entryId: string): Promise<PluginStorePreflightViewV1>;
    acquire(entryId: string): Promise<PluginStoreAcquireOutcomeV1>;
    cancel(entryId: string, options?: Readonly<{
        discard?: boolean;
    }>): Promise<void>;
    rollback(entryId: string): Promise<PluginStoreRollbackOutcomeV1>;
    library(): Promise<PluginStoreAuthorLibraryV1>;
    onEvent(listener: (event: PluginStoreAuthorEventV1) => void): () => void;
}
export interface PluginBackendApiV1 {
    call(method: string, params: JsonValue): Promise<JsonValue>;
}
export interface PluginAgentAvatarApiV1 {
    read(agentId: string): Promise<PluginAgentAvatarResultV1['image']>;
}
export type PluginProgramPermissionV1 = keyof typeof PLUGIN_PROGRAM_PERMISSION_SCOPES_V1;
export type PluginProgramScopeV1 = (typeof PLUGIN_PROGRAM_PERMISSION_SCOPES_V1)[PluginProgramPermissionV1] | 'admin';
export type PluginProgramOperationNameV1 = 'program.describe' | 'conversation.dispatch' | 'conversation.read' | 'conversation.followUp' | 'data.projects.list' | 'data.projects.get' | 'data.projects.create' | 'data.projects.update' | 'data.projects.delete' | 'data.milestones.list' | 'data.milestones.get' | 'data.milestones.create' | 'data.milestones.update' | 'data.milestones.delete' | 'data.tasks.list' | 'data.tasks.get' | 'data.tasks.create' | 'data.tasks.update' | 'data.tasks.delete';
export type PluginProgramInputByOperationV1 = {
    'program.describe': Record<never, never>;
    'conversation.dispatch': Readonly<{
        target: Readonly<{
            kind: 'project';
            projectId: string;
        }> | Readonly<{
            kind: 'task';
            taskId: string;
        }>;
        provider: string;
        input: string;
        model?: string;
        effort?: string;
    }>;
    'conversation.read': Readonly<{
        conversationId: string;
        limit?: number;
        startSequence?: number;
    }>;
    'conversation.followUp': Readonly<{
        conversationId: string;
        text: string;
    }>;
    'data.projects.list': Readonly<{
        limit?: number;
        cursor?: string | null;
        snapshotGeneration?: number;
        search?: string | null;
    }>;
    'data.projects.get': Readonly<{
        projectId: string;
    }>;
    'data.projects.create': Readonly<{
        name: string;
        description?: string | null;
    }>;
    'data.projects.update': Readonly<{
        projectId: string;
        expectedAuthoredRevision: number;
        name?: string;
        description?: string | null;
    }>;
    'data.projects.delete': Readonly<{
        projectId: string;
        expectedAuthoredRevision: number;
    }>;
    'data.milestones.list': Readonly<{
        projectId?: string | null;
        limit?: number;
        cursor?: string | null;
        snapshotGeneration?: number;
    }>;
    'data.milestones.get': Readonly<{
        milestoneId: string;
    }>;
    'data.milestones.create': Readonly<{
        name: string;
        projectId?: string | null;
        description?: string | null;
    }>;
    'data.milestones.update': Readonly<{
        milestoneId: string;
        expectedAuthoredRevision: number;
        name?: string;
        description?: string | null;
    }>;
    'data.milestones.delete': Readonly<{
        milestoneId: string;
        expectedAuthoredRevision: number;
    }>;
    'data.tasks.list': Readonly<{
        limit?: number;
        cursor?: string | null;
        snapshotGeneration?: number;
        search?: string | null;
        projectId?: string | null;
    }>;
    'data.tasks.get': Readonly<{
        taskId: string;
    }>;
    'data.tasks.create': Readonly<{
        name: string;
        description?: string | null;
        projectId: string | null;
        milestoneId?: string | null;
    }>;
    'data.tasks.update': Readonly<{
        taskId: string;
        expectedAuthoredRevision: number;
        name?: string;
        description?: string | null;
        status?: PluginProgramTaskStatusV1;
    }>;
    'data.tasks.delete': Readonly<{
        taskId: string;
        expectedAuthoredRevision: number;
    }>;
};
export type PluginProgramPageV1<T> = Readonly<{
    items: readonly T[];
    nextCursor: string | null;
    snapshotGeneration: number;
}>;
export type PluginProgramProjectV1 = Readonly<{
    id: string;
    name: string;
    description: string | null;
    authoredRevision: number;
    archived: boolean;
    readOnly: boolean | null;
}>;
export type PluginProgramMilestoneV1 = Readonly<{
    id: string;
    name: string;
    description: string | null;
    projectId: string | null;
    authoredRevision: number;
    archived: boolean;
    readOnly: boolean | null;
}>;
export type PluginProgramTaskV1 = Readonly<{
    id: string;
    name: string;
    description: string | null;
    projectId: string | null;
    milestoneId: string | null;
    status: string;
    authoredRevision: number;
    deletedAt: number | null;
    readOnly: boolean | null;
}>;
export type PluginProgramReceiptV1 = 'accepted' | 'delivered' | 'unknown';
export type PluginProgramResultByOperationV1 = {
    'program.describe': {
        apiVersion: 1;
        operations: Array<{
            operation: PluginProgramOperationNameV1;
            requiredScope: PluginProgramScopeV1 | 'none';
            available: boolean;
            summary: string;
        }>;
    };
    'conversation.dispatch': Readonly<{
        conversationId: string;
        taskId: string | null;
        turnId: string;
        receipt: PluginProgramReceiptV1;
    }>;
    'conversation.read': {
        state: 'ready' | 'partial';
        messages: Array<{
            sequenceNo: number;
            role: 'user' | 'assistant';
            text: string;
            truncated: boolean;
        }>;
        nextSequence: number | null;
    };
    'conversation.followUp': Readonly<{
        turnId: string;
        receipt: PluginProgramReceiptV1;
    }>;
    'data.projects.list': PluginProgramPageV1<PluginProgramProjectV1>;
    'data.projects.get': PluginProgramProjectV1;
    'data.projects.create': PluginProgramProjectV1;
    'data.projects.update': PluginProgramProjectV1;
    'data.projects.delete': PluginProgramProjectV1;
    'data.milestones.list': PluginProgramPageV1<PluginProgramMilestoneV1>;
    'data.milestones.get': PluginProgramMilestoneV1;
    'data.milestones.create': PluginProgramMilestoneV1;
    'data.milestones.update': PluginProgramMilestoneV1;
    'data.milestones.delete': PluginProgramMilestoneV1;
    'data.tasks.list': PluginProgramPageV1<PluginProgramTaskV1>;
    'data.tasks.get': PluginProgramTaskV1;
    'data.tasks.create': PluginProgramTaskV1;
    'data.tasks.update': PluginProgramTaskV1;
    'data.tasks.delete': PluginProgramTaskV1;
};
export type PluginProgramErrorCodeV1 = 'invalid_request' | 'unsupported_version' | 'operation_not_supported' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'unavailable' | 'internal_error';
export type PluginProgramFieldV1 = 'apiVersion' | 'requestId' | 'operation' | 'input' | 'target' | 'provider' | 'name' | 'description' | 'projectId' | 'milestoneId' | 'taskId' | 'expectedAuthoredRevision' | 'conversationId' | 'text' | 'limit' | 'cursor' | 'snapshotGeneration' | 'startSequence' | 'status';
export type PluginProgramFieldIssueV1 = 'required' | 'invalid_type' | 'unknown_key' | 'invalid_value' | 'too_small' | 'too_large' | 'invalid_format' | 'empty' | 'unsupported';
export type PluginProgramErrorV1 = Readonly<{
    code: PluginProgramErrorCodeV1;
    message: string;
    details?: Array<{
        field: PluginProgramFieldV1;
        issue: PluginProgramFieldIssueV1;
    }>;
}>;
export type PluginProgramCallV1 = {
    [K in PluginProgramOperationNameV1]: Readonly<{
        apiVersion: 1;
        requestId: string;
        operation: K;
        input: PluginProgramInputByOperationV1[K];
    }>;
}[PluginProgramOperationNameV1];
export type PluginProgramReplyForV1<K extends PluginProgramOperationNameV1> = (K extends PluginProgramOperationNameV1 ? Readonly<{
    apiVersion: 1;
    requestId: string;
    operation: K;
    ok: true;
    result: PluginProgramResultByOperationV1[K];
}> : never) | Readonly<{
    apiVersion: 1;
    requestId: string | null;
    operation: string | null;
    ok: false;
    error: PluginProgramErrorV1;
}>;
export type PluginProgramReplyV1 = PluginProgramReplyForV1<PluginProgramOperationNameV1>;
export type PluginProgramHostCallV1 = Readonly<{
    caller: Readonly<{
        pluginId: string;
        viewToken: string;
    }>;
    request: PluginProgramCallV1;
    canOpen(): boolean;
}>;
export interface PluginProgramApiV1 {
    call<K extends PluginProgramOperationNameV1>(operation: K, input: PluginProgramInputByOperationV1[K], options?: Readonly<{
        requestId?: string;
    }>): Promise<PluginProgramReplyForV1<K>>;
}
export interface PluginStoreStatusViewV1 {
    readonly state: 'disabled' | 'fresh' | 'stale' | 'offline' | 'untrusted';
    readonly ageSec: number | null;
    readonly acquirable: boolean;
}
export interface PluginStoreListQueryV1 {
    readonly text?: string;
    readonly tags?: readonly string[];
    readonly cursor?: string | null;
    readonly limit?: number;
}
export interface PluginStoreListViewV1 {
    readonly entries: readonly PluginStoreEntryViewV1[];
    readonly nextCursor: string | null;
}
export interface PluginStoreEntryDetailViewV1 extends PluginStoreEntryViewV1 {
    readonly description: string;
    readonly previews: readonly PluginStorePreviewViewV1[];
}
export interface PluginStorePreflightViewV1 {
    readonly downloadBytes: number;
    readonly installedBytes: number;
    readonly neededBytes: number;
    readonly reserveBytes: number;
    readonly freeBytes: number;
    readonly enough: boolean;
}
export type PluginStoreAcquireOutcomeV1 = Readonly<{
    status: 'installed' | 'updated';
    packId: string;
    version: string;
    name: string;
}> | Readonly<{
    status: 'cancelled';
}>;
export type PluginStoreRollbackOutcomeV1 = Readonly<{
    status: 'rolled_back';
    packId: string;
    version: string;
    name: string;
}> | Readonly<{
    status: 'cancelled';
}> | Readonly<{
    status: 'no_previous';
}>;
export type PluginStoreAuthorLibraryV1 = { protocolVersion: 1; installed: { name: string; state: "ready" | "hidden" | "disabled" | "removed"; entryId: string; packId: string; version: string; updateVersion: string | null; }[]; downloads: { name: string; entryId: string; version: string | null; stage: "confirming" | "downloading" | "verifying" | "installing"; bytesReceived: number; bytesTotal: number | null; }[]; }
export type PluginStoreAuthorEventV1 = { type: "progress"; protocolVersion: 1; entryId: string; stage: "confirming" | "downloading" | "verifying" | "installing"; bytesReceived: number; bytesTotal: number | null; } | { type: "outcome"; status: "installed" | "updated" | "cancelled" | "failed"; protocolVersion: 1; entryId: string; } | { type: "library-changed"; protocolVersion: 1; entryId: string; }
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type PluginAgentAvatarResultV1 = Readonly<{
    protocolVersion: 1;
    image: Readonly<{
        mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
        bytes: Uint8Array;
    }> | null;
}>;
export type PluginProgramTaskStatusV1 = 'PREPARATION' | 'WAITING' | 'IN_PROGRESS' | 'PENDING_CONFIRMATION' | 'PENDING' | 'COMPLETED';
export interface PluginBackendAiApiV1 {
    getOptions(): Promise<PluginBackendAiOptionsV1>;
    openSession(options: PluginBackendAiOpenOptionsV1): Promise<PluginBackendAiSessionV1>;
    complete(input: PluginBackendAiCompleteInputV1): Promise<PluginBackendAiCompleteResultV1>;
}
export interface PluginBackendSecretsApiV1 {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    remove(name: string): Promise<void>;
    list(): Promise<string[]>;
    available(): Promise<boolean>;
}
export interface PluginBackendTeamUpQuickApiV1 {
    request(input: TeamUpQuickApiRequestV1): Promise<TeamUpQuickApiResultV1>;
    currentAccount(): Promise<TeamUpQuickAccountV1>;
    onAccountChanged(listener: (event: TeamUpQuickAccountV1) => void): () => void;
}
export interface PluginBackendSlotsApiV1 {
    invalidate(request: Readonly<{
        slot: PluginSlotKind;
        taskIds?: readonly string[];
    }>): Promise<PluginSlotInvalidateResultV1>;
}
export interface PluginBackendBackgroundApiV1 {
    onWake(listener: (event: PluginBackgroundWakeV1) => void): () => void;
}
export type PluginHostWorkSnapshotDiagnosticsV1 = { snapshotId: string; generation: string; highWatermark: string | null; processed: number; scanned: number; returned: number; schemaSkipped: number; complete: boolean; }
export interface CapabilityHostPort {
    list(): Promise<readonly CapabilityListEntry[]>;
    openLink(category: string, request?: OpenLinkOptions): Promise<HostLinkTicket>;
    onChange(handler: (event: CapabilityHostEvent) => void): Unsubscribe;
}
export type PluginBackendResidencyV1 = { requested: boolean; level: "on-demand" | "resident"; reason: "resident_not_granted" | "resident_inactive" | "resident_budget_exceeded" | "resident_crash_budget_exhausted" | "resident_boot_failed" | "resident_artifact_revoked" | "resident_revalidation_failed" | "resident_policy_error" | null; }
export interface PluginStoreEntryViewV1 {
    readonly entryId: string;
    readonly packId: string;
    readonly version: string;
    readonly name: string;
    readonly summary: string;
    readonly tags: readonly string[];
    readonly creator: string;
    readonly downloadBytes: number;
    readonly installedBytes: number;
    readonly consentLabel: string | null;
}
export interface PluginStorePreviewViewV1 {
    readonly role: 'cover' | 'video' | 'voice';
    readonly mime: string;
    readonly sizeBytes: number;
    readonly width: number | null;
    readonly height: number | null;
    readonly durationMs: number | null;
    readonly url: string;
}
export type PluginBackendAiOptionsV1 = {
    providers: Array<{
        id: string;
        label: string;
        state: 'ready' | 'not_installed' | 'not_logged_in' | 'unsupported_version' | 'unavailable' | 'not_supported_yet';
        models: Array<{
            id: string;
            label: string;
            efforts: string[];
            defaultEffort: string | null;
            supportsImages: boolean;
            isDefault: boolean;
        }>;
    }>;
    defaultProviderId: string | null;
    capabilities?: {
        closedSessionResume?: boolean;
    };
    limits: {
        systemChars: number;
        transcriptLines: number;
        transcriptChars: number;
        inputChars: number;
        imageBytes: number;
        turnsPerMinute: number;
    };
    quota: {
        state: 'ok' | 'exhausted';
        retryAfterMs: number | null;
    };
};
export type PluginBackendAiOpenOptionsV1 = {
    taskId?: string;
    providerId?: string;
    modelId?: string;
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    system: string;
    transcript?: Array<{
        role: 'user' | 'assistant';
        text: string;
    }>;
    resume?: undefined;
} | {
    resume: string;
    taskId?: string;
};
export interface PluginBackendAiSessionV1 {
    readonly sessionId: string;
    readonly effective: {
        providerId: string;
        modelId: string;
        effort: string | null;
    };
    readonly turn: {
        turnId: string;
        text: string;
        terminal: PluginBackendAiTurnBodyV1 | null;
    } | null;
    send(input: {
        text: string;
        image?: {
            mime: 'image/jpeg' | 'image/png';
            data: Uint8Array;
        };
    }): Promise<{
        turnId: string;
    }>;
    onEvent(listener: (event: PluginBackendAiTurnEventV1) => void): () => void;
    interrupt(): Promise<void>;
    close(): Promise<void>;
}
export type PluginBackendAiCompleteInputV1 = { text: string; system: string; taskId?: string | undefined; effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined; providerId?: string | undefined; modelId?: string | undefined; transcript?: { text: string; role: "user" | "assistant"; }[] | undefined; image?: { mime: "image/jpeg" | "image/png"; data: Uint8Array<ArrayBufferLike>; } | undefined; } | { text: string; sessionId: string; taskId?: string | undefined; effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined; modelId?: string | undefined; image?: { mime: "image/jpeg" | "image/png"; data: Uint8Array<ArrayBufferLike>; } | undefined; }
export type PluginBackendAiCompleteResultV1 = AiChatCompleteResult;
export type TeamUpQuickApiRequestV1 = {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
};
export type TeamUpQuickApiResultV1 = {
    ok: true;
    status: number;
    headers: Record<string, string>;
    body: unknown;
    accountKey: string;
} | {
    ok: false;
    code: TeamUpQuickApiErrorCodeV1;
    retryable: boolean;
    status: number | null;
    body?: unknown;
    retryAfterMs?: number;
    outcomeUnknown?: true;
    accountKey: string | null;
};
export type TeamUpQuickAccountV1 = {
    state: 'signed_in' | 'signed_out' | 'needs_relogin' | 'unavailable' | 'not_allowed';
    accountKey: string | null;
};
export type PluginSlotKind = 'project.connection' | 'task.badge';
export type PluginSlotInvalidateResultV1 = { ok: true; } | { code: "unavailable" | "slot_not_declared" | "request_invalid"; ok: false; }
export type PluginBackgroundWakeV1 = { reason: "startup" | "tick"; }
export interface CapabilityListEntry {
    readonly category: string;
    readonly status: ViewStatus;
    readonly providers: readonly CandidateProvider[];
    readonly selected?: string;
}
export interface OpenLinkOptions {
    readonly providerId?: string;
    readonly scope?: 'use' | 'describe';
    readonly groups?: readonly string[];
    readonly intent?: 'enroll' | 'recognize';
}
export interface HostLinkTicket {
    readonly linkId: string;
    readonly provider: ProviderView;
    readonly endpoint: string;
    readonly ticket: string;
    readonly expiresAt: number;
}
export type CapabilityHostEvent = {
    readonly kind: 'change';
    readonly category: string;
    readonly status: ViewStatus;
    readonly provider: ProviderView | null;
    readonly reason: string;
} | {
    readonly kind: 'link-closed';
    readonly linkId: string;
    readonly reason: CloseReason;
};
export type Unsubscribe = () => void;
export type PluginBackendAiTurnBodyV1 = {
    kind: 'started';
} | {
    kind: 'textDelta';
    text: string;
} | {
    kind: 'contentSaved';
    sequenceNo: number;
} | {
    kind: 'completed';
} | {
    kind: 'interrupted';
} | {
    kind: 'failed';
    code: 'provider_unavailable' | 'unsupported_version' | 'quota_exhausted' | 'stalled' | 'provider_error' | 'empty_reply' | 'session_closed' | 'reply_too_long' | 'turn_timeout' | 'access_revoked';
    retryable: boolean;
    fallbackUsed: boolean;
    partialDelivered: boolean;
};
export type PluginBackendAiTurnEventV1 = PluginBackendAiTurnBodyV1 & {
    turnId: string;
};
export type AiChatCompleteResult = { text: string; requestId: string; sessionId: string; providerTurnId: string | null; historySaved: "pending" | "saved"; }
export type TeamUpQuickApiErrorCodeV1 = 'plugin_not_allowed' | 'permission_denied' | 'request_invalid' | 'method_not_allowed' | 'path_not_allowed' | 'query_not_allowed' | 'payload_too_large' | 'rate_limited' | 'account_unavailable' | 'needs_relogin' | 'unauthorized' | 'forbidden' | 'upstream_rate_limited' | 'server_error' | 'http_error' | 'timeout' | 'network_error' | 'response_invalid' | 'response_too_large' | 'unavailable';
export type ViewStatus = 'available' | 'provider_not_ready' | 'provider_not_allowed' | 'unresolved' | 'not_granted';
export interface CandidateProvider extends ProviderView {
    readonly dataClass: 'local' | 'cloud';
}
export interface ProviderView {
    readonly id: string;
    readonly version: string;
    readonly name: string;
    readonly signer: 'teamuq' | 'dev' | 'unsigned';
}
export type CloseReason = 'consumer_closed' | 'view_hidden' | 'view_occluded' | 'view_closed' | 'view_reloaded' | 'provider_gone' | 'provider_crashed' | 'provider_closed' | 'consumer_gone' | 'rate_limited' | 'idle_timeout' | 'permission_revoked' | 'protocol_error' | 'shutdown';
export interface PluginPresentationApiV1 {
  get(): Promise<{ mode: 'tab' | 'fullpage'; fullscreen: boolean; visible: boolean }>
  request(mode: 'tab' | 'window' | 'fullpage' | 'overlay', options?: { fullscreen?: boolean }): Promise<
    | { ok: true; state: { mode: 'tab' | 'fullpage'; fullscreen: boolean; visible: boolean } }
    | {
        ok: false
        error:
          | 'presentation_not_declared'
          | 'presentation_not_granted'
          | 'presentation_requires_focus'
          | 'presentation_rate_limited'
          | 'presentation_requires_fullpage'
          | 'presentation_not_visible'
          | 'presentation_view_unavailable'
      }>
  onChange(listener: (event: {
    phase: 'before' | 'after'
    from: 'tab' | 'fullpage'
    to: 'tab' | 'fullpage'
    fullscreen: boolean
    visible: boolean
    reason: 'user' | 'plugin' | 'core' | 'escape' | 'window'
  }) => void): () => void
}
export interface PluginViewApiV1 {
  getContext(): Promise<{ projectId: string | null; taskId: string | null }>
  onContextChanged(listener: (event: { projectId: string | null; taskId: string | null }) => void): () => void
}
export interface PluginStorageApiV1 {
  read(path: string, range?: { offset?: number; length?: number }): Promise<Uint8Array>
  readText(path: string): Promise<string>
  write(path: string, data: Uint8Array | ArrayBuffer | string, options?: { append?: boolean }): Promise<{ size: number }>
  list(path?: string): Promise<{ name: string; kind: 'file' | 'directory'; size: number }[]>
  stat(path: string): Promise<{ kind: 'file' | 'directory'; size: number; modifiedMs: number } | null>
  remove(path: string, options?: { recursive?: boolean }): Promise<{ removed: boolean }>
}
export interface PluginSettingsApiV1 {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<true>
  remove(key: string): Promise<true>
  all(): Promise<Record<string, unknown>>
}
export interface PluginSecretsApiV1 {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<true>
  remove(name: string): Promise<true>
  list(): Promise<string[]>
  available(): Promise<boolean>
}
export interface PluginInputApiV1 {
  provide(onMessage: (message:
    | {
        type: 'input'
        inputId: string
        text: string
        source: 'voice' | 'typed' | 'schedule'
        callerId: 'core'
        receivedAtMs: number
        arrivedWhileSpeaking: boolean
        utterance?: { startMs: number; endMs: number; sourceId?: string; utteranceId?: string }
      }
    | { type: 'interrupt'; reason: 'escape'; receivedAtMs: number }) => void | Partial<{ result: 'accepted' | 'dropped' | 'busy'; reason?: string }> | Promise<void | Partial<{ result: 'accepted' | 'dropped' | 'busy'; reason?: string }>>): Promise<{ registered: boolean; current: boolean }>
  stop(): Promise<{ registered: boolean; current: boolean }>
  setSpeaking(speaking: boolean): Promise<{ registered: boolean; current: boolean }>
  state(): Promise<{ registered: boolean; current: boolean }>
}
export interface PluginAiSessionV1 {
  readonly sessionId: string
  readonly effective: { providerId: string; modelId: string; effort: string | null }
  readonly turn?: {
    turnId: string
    text: string
    terminal:
      | { kind: 'started' }
      | { kind: 'textDelta'; text: string }
      | { kind: 'contentSaved'; sequenceNo: number }
      | { kind: 'completed' }
      | { kind: 'interrupted' }
      | {
          kind: 'failed'
          code:
            | 'provider_unavailable'
            | 'unsupported_version'
            | 'quota_exhausted'
            | 'stalled'
            | 'provider_error'
            | 'empty_reply'
            | 'session_closed'
            | 'reply_too_long'
            | 'turn_timeout'
            | 'access_revoked'
          retryable: boolean
          fallbackUsed: boolean
          partialDelivered: boolean
        }
      | null
  } | null
  send(input: { text?: string; image?: { mime: 'image/jpeg' | 'image/png'; data: Uint8Array | ArrayBuffer } }): Promise<{ turnId: string }>
  onEvent(listener: (event:
    | { kind: 'started'; turnId: string }
    | { kind: 'textDelta'; text: string; turnId: string }
    | { kind: 'contentSaved'; sequenceNo: number; turnId: string }
    | { kind: 'completed'; turnId: string }
    | { kind: 'interrupted'; turnId: string }
    | {
        kind: 'failed'
        code:
          | 'provider_unavailable'
          | 'unsupported_version'
          | 'quota_exhausted'
          | 'stalled'
          | 'provider_error'
          | 'empty_reply'
          | 'session_closed'
          | 'reply_too_long'
          | 'turn_timeout'
          | 'access_revoked'
        retryable: boolean
        fallbackUsed: boolean
        partialDelivered: boolean
        turnId: string
      }) => void): () => void
  interrupt(): Promise<void>
  close(): Promise<void>
}
export interface PluginAiApiV1 {
  getOptions(): Promise<{
    providers: {
      id: string
      label: string
      state:
        | 'ready'
        | 'not_installed'
        | 'not_logged_in'
        | 'unsupported_version'
        | 'unavailable'
        | 'not_supported_yet'
      models: {
        id: string
        label: string
        efforts: string[]
        defaultEffort: string | null
        supportsImages: boolean
        isDefault: boolean
      }[]
    }[]
    defaultProviderId: string | null
    capabilities?: { closedSessionResume?: boolean }
    limits: {
      systemChars: number
      transcriptLines: number
      transcriptChars: number
      inputChars: number
      imageBytes: number
      turnsPerMinute: number
    }
    quota: { state: 'ok' | 'exhausted'; retryAfterMs: number | null }
  }>
  openSession(options: {
    taskId?: string
    providerId?: string
    modelId?: string
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    system: string
    transcript?: { role: 'user' | 'assistant'; text: string }[]
    resume?: string
  }): Promise<PluginAiSessionV1>
  complete(input: {
    taskId?: string
    providerId?: string
    modelId?: string
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    system: string
    transcript?: { role: 'user' | 'assistant'; text: string }[]
    text: string
    image?: { mime: 'image/jpeg' | 'image/png'; data: Uint8Array }
  } | {
    taskId?: string
    sessionId: string
    modelId?: string
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    text: string
    image?: { mime: 'image/jpeg' | 'image/png'; data: Uint8Array }
  }): Promise<{
    sessionId: string
    requestId: string
    text: string
    providerTurnId: string | null
    historySaved: 'pending' | 'saved'
  }>
}
export interface PluginCapabilityApiV1 {
  list(): Promise<{
    category: string
    status: 'available' | 'provider_not_ready' | 'provider_not_allowed' | 'unresolved' | 'not_granted'
    providers: {
      id: string
      version: string
      name: string
      signer: 'teamuq' | 'dev' | 'unsigned'
      dataClass: 'local' | 'cloud'
    }[]
    selected?: string
  }[]>
  openLink(category: string, request?: {
    providerId?: string
    scope?: 'use' | 'describe'
    groups?: string[]
    intent?: 'enroll' | 'recognize'
  }): Promise<{
    linkId: string
    provider: { id: string; version: string; name: string; signer: 'teamuq' | 'dev' | 'unsigned' }
    endpoint: string
    ticket: string
    expiresAt: number
  }>
  onChange(listener: (event:
    | {
        kind: 'change'
        category: string
        status: 'available' | 'provider_not_ready' | 'provider_not_allowed' | 'unresolved' | 'not_granted'
        provider: { id: string; version: string; name: string; signer: 'teamuq' | 'dev' | 'unsigned' } | null
        reason: string
      }
    | {
        kind: 'link-closed'
        linkId: string
        reason:
          | 'consumer_closed'
          | 'view_hidden'
          | 'view_occluded'
          | 'view_closed'
          | 'view_reloaded'
          | 'provider_gone'
          | 'provider_crashed'
          | 'provider_closed'
          | 'consumer_gone'
          | 'rate_limited'
          | 'idle_timeout'
          | 'permission_revoked'
          | 'protocol_error'
          | 'shutdown'
      }) => void): () => void
}
export interface PluginAssetPacksApiV1 {
  list(): Promise<{
    id: string
    range: string
    required: boolean
    status: 'ready' | 'missing' | 'version_mismatch' | 'signer_mismatch' | 'invalid'
    version: string | null
  }[]>
  files(packId: string): Promise<{ path: string; size: number }[]>
  import(): Promise<
    | {
        status: 'installed'
        pack: {
          id: string
          version: string
          name: string
          sizeBytes: number
          fileCount: number
          status: 'ready' | 'invalid'
        }
      }
    | { status: 'cancelled' }>
  remove(packId: string): Promise<{ status: 'removed'; packId: string } | { status: 'cancelled' }>
  acquire(packId: string): Promise<{ status: 'installed' | 'updated'; packId: string; version: string }>
  cancel(packId: string): Promise<void>
  onProgress(listener: (event: {
    packId: string
    stage:
      | 'resolving'
      | 'confirming'
      | 'downloading'
      | 'verifying'
      | 'installing'
      | 'complete'
      | 'failed'
      | 'cancelled'
    bytesReceived: number
    bytesTotal: number | null
    error:
      | 'model_signin_required'
      | 'model_unavailable'
      | 'model_invalid_response'
      | 'model_package_not_found'
      | 'model_no_published_version'
      | 'model_no_matching_version'
      | 'model_not_owned'
      | 'model_too_large'
      | 'model_disk_insufficient'
      | 'model_download_failed'
      | 'model_hash_mismatch'
      | 'model_signature_invalid'
      | 'model_busy'
      | 'model_cancelled'
      | null
  }) => void): () => void
}
}
interface Window {
  tuqPlugin: {
    presentation: import('@teamuq/plugin-sdk').PluginPresentationApiV1
    view: import('@teamuq/plugin-sdk').PluginViewApiV1
    storage: import('@teamuq/plugin-sdk').PluginStorageApiV1
    settings: import('@teamuq/plugin-sdk').PluginSettingsApiV1
    secrets: import('@teamuq/plugin-sdk').PluginSecretsApiV1
    input: import('@teamuq/plugin-sdk').PluginInputApiV1
    ai: import('@teamuq/plugin-sdk').PluginAiApiV1
    capability: import('@teamuq/plugin-sdk').PluginCapabilityApiV1
    assetPacks: import('@teamuq/plugin-sdk').PluginAssetPacksApiV1
    store: Pick<import('@teamuq/plugin-sdk').PluginStoreApiV1, 'status' | 'list' | 'get' | 'library' | 'preflight' | 'acquire' | 'cancel' | 'rollback' | 'onEvent'>
    backend: Pick<import('@teamuq/plugin-sdk').PluginBackendApiV1, 'call'>
    agentAvatar: Pick<import('@teamuq/plugin-sdk').PluginAgentAvatarApiV1, 'read'>
    program: Pick<import('@teamuq/plugin-sdk').PluginProgramApiV1, 'call'>
  }
}
declare module '@teamuq/plugin-sdk/external' {
type PluginProgramApiV1 = import('@teamuq/plugin-sdk').PluginProgramApiV1
type PluginBackendAiApiV1 = import('@teamuq/plugin-sdk').PluginBackendAiApiV1
type PluginBackendSecretsApiV1 = import('@teamuq/plugin-sdk').PluginBackendSecretsApiV1
type PluginBackendTeamUpQuickApiV1 = import('@teamuq/plugin-sdk').PluginBackendTeamUpQuickApiV1
type PluginBackendSlotsApiV1 = import('@teamuq/plugin-sdk').PluginBackendSlotsApiV1
type PluginBackendBackgroundApiV1 = import('@teamuq/plugin-sdk').PluginBackendBackgroundApiV1
type CapabilityHostPort = import('@teamuq/plugin-sdk').CapabilityHostPort
type PluginBackendResidencyV1 = import('@teamuq/plugin-sdk').PluginBackendResidencyV1
export interface PluginProcessHelperApiV1 {
    openBundledHelper(helperId: string): Promise<void>;
    write(helperId: string, bytes: Uint8Array): Promise<void>;
    read(helperId: string, maxBytes?: number): Promise<Uint8Array | null>;
    close(helperId: string): Promise<void>;
}
export interface PluginHostApiV1 {
    readonly program: PluginProgramApiV1;
    readonly ai: PluginBackendAiApiV1;
    readonly secrets: PluginBackendSecretsApiV1;
    readonly teamUpQuick: PluginBackendTeamUpQuickApiV1;
    readonly slots: PluginBackendSlotsApiV1;
    readonly background: PluginBackendBackgroundApiV1;
    readonly workRecords: Readonly<{
        readPage(request: {
            snapshotId?: string;
            cursor: string | null;
            limit: number;
        }): Promise<{
            snapshot: {
                snapshotId: string;
                generation: string;
                highWatermark: string | null;
                idEpoch?: string;
            };
            records: Array<{
                id: string;
                agentId: string;
                projectId: string | null;
                taskId?: string | null;
                sessionId: string | null;
                providerId: string | null;
                punchId: string;
                punchType: 'main' | 'subagent';
                startedAtMs: number;
                endedAtMs: number;
                model: string | null;
                name: string | null;
                description: string | null;
                textTruncated?: boolean;
            }>;
            nextCursor: string | null;
        }>;
        readChanges(request: {
            cursor: string | null;
            limit: number;
        }): Promise<{
            idEpoch: string;
            changes: Array<{
                kind: 'upsert';
                record: {
                    id: string;
                    agentId: string;
                    projectId: string | null;
                    taskId: string | null;
                    sessionId: string | null;
                    providerId: string | null;
                    punchId: string;
                    punchType: 'main' | 'subagent';
                    startedAtMs: number;
                    endedAtMs: number;
                    model: string | null;
                    name: string | null;
                    description: string | null;
                    textTruncated: boolean;
                };
                updatedAtMs: number;
            } | {
                kind: 'retracted';
                id: string;
                updatedAtMs: number;
                reason: 'not_done' | 'deleted';
            }>;
            nextCursor: string;
            hasMore: boolean;
        }>;
        readSnapshotDiagnostics?(request: {
            readonly snapshotId: string;
        }): Promise<PluginHostWorkSnapshotDiagnosticsV1>;
        subscribeSettledChanges(listener: (event: {
            protocolVersion: 1;
            kind: 'ext-capability-event';
            capabilityId: 'teamuq.work-records@1';
            event: 'settled-changed';
            generation: string;
            highWatermark: string | null;
            idEpoch?: string;
        }) => void): () => void;
    }>;
    readonly taskChanges: Readonly<{
        watchProjects(request: {
            projectIds: readonly string[];
        }): Promise<{
            watched: number;
        }>;
        readChanges(request: {
            cursor: string | null;
            limit: number;
        }): Promise<{
            epoch: string;
            changes: Array<{
                taskId: string;
                projectId: string | null;
                authoredRevision: number;
                status: string;
                deleted: boolean;
                changedAtMs: number;
            }>;
            nextCursor: string;
            hasMore: boolean;
            gap: boolean;
        }>;
        onChanged(listener: (event: {
            protocolVersion: 1;
            kind: 'ext-capability-event';
            capabilityId: 'teamuq.task-changes@1';
            event: 'changed';
            epoch: string;
        }) => void): () => void;
    }>;
    readonly agentDirectory: Readonly<{
        readPage(request: {
            snapshotId?: string;
            cursor: string | null;
            limit: number;
        }): Promise<{
            snapshot: {
                snapshotId: string;
                generation: string;
                highWatermark: string | null;
                idEpoch?: string;
            };
            entries: Array<{
                id: string;
                name: string;
                teamKey: string;
                teamName: string | null;
                title: string;
                enabled: boolean;
            }>;
            nextCursor: string | null;
        }>;
    }>;
    readonly projectDirectory: Readonly<{
        readPage(request: {
            snapshotId?: string;
            cursor: string | null;
            limit: number;
        }): Promise<{
            snapshot: {
                snapshotId: string;
                generation: string;
                highWatermark: string | null;
                idEpoch?: string;
            };
            entries: Array<{
                id: string;
                name: string;
                archived: boolean;
            }>;
            nextCursor: string | null;
        }>;
    }>;
    readonly pluginState: Readonly<{
        readPage(namespace: string, cursor: string | null, limit: number): Promise<{
            records: Array<{
                key: string;
                value: unknown;
                sourceKind?: string | null;
                sourceId?: string | null;
                revision: number;
            }>;
            nextCursor: string | null;
        }>;
        writeBatch(namespace: string, records: readonly {
            key: string;
            value: unknown;
            sourceKind?: string | null;
            sourceId?: string | null;
            expectedRevision?: number | null;
        }[]): Promise<void>;
        deleteBatch(namespace: string, keys: readonly string[]): Promise<void>;
    }>;
}
export type PluginBackendContextV1 = Readonly<{
    readonly pluginId: string;
    readonly dataDir: string;
    readonly assetPacks: Readonly<Record<string, string>>;
    readonly allowAddons: boolean;
    readonly host: PluginHostApiV1;
    readonly capabilities: CapabilityHostPort;
    readonly processHelper?: PluginProcessHelperApiV1;
    readonly settings: Readonly<{
        all(): Readonly<Record<string, boolean | number | string>>;
        get(key: string): boolean | number | string | undefined;
        onChange(listener: (values: Readonly<Record<string, boolean | number | string>>) => void): () => void;
    }>;
    readonly residency: Readonly<{
        current(): PluginBackendResidencyV1;
        onChange(listener: (residency: PluginBackendResidencyV1) => void): () => void;
    }>;
}>;
}
