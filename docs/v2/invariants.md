# v2 Behavioral Invariants and Route Parity

Durable contract extracted from v1 (`internal/chat` engine + `internal/api` bridge) so the
v2 Unix-socket RPC rebuild cannot silently drop hard-won behavior. Every invariant cites the
v1 test file (all under `cli-webchat/internal/chat/` unless prefixed `api:`) that pins it.
V1 concurrency canon: `manager.go` header comment, `AGENTS.md`, `compact_lifecycle_test.go`
(632 LOC), `omo_lifecycle_test.go` (536 LOC).

## INVARIANTS

1. **Lock order is fixed**: `Session.lifecycleMu -> Manager.mu -> sharedProvider.mu -> Session.mu`.
   A path may skip locks but never acquire them in reverse; no lock in this order may be held
   across provider I/O or a channel receive. Manager code snapshots the Session pointer and
   releases `Manager.mu` before waiting on `lifecycleMu`; provider callbacks release
   `sharedProvider.mu` before re-entering Manager. In v2 terms: whatever replaces these locks
   must allow provider exit during a blocked sweep-acquire-and-close.
   Sources: `manager.go:26-31`; `shared_provider_lifecycle_test.go:TestManagerLockOrderAllowsProviderExitDuringBlockedSweepAcquireAndClose`.

2. **Session-scoped failure isolation on the shared provider**: one session's wedged writer,
   write timeout, send deadline, or cancelled open must stay local to that session — it must
   never terminate the provider process or stall sibling sessions. Pinned contracts:
   (a) no session-scoped action kills the provider; (b) `Send` returns in finite time;
   (c) open delay/cancel fails only that open; (d) provider lifetime belongs to manager
   lifecycle only.
   Sources: `shared_provider_mass_kill_pin_test.go:30-33,TestSharedProviderWedgedCloseIsLocal,TestProcessSendDeadlineAndBoundedQueue,TestOpenSessionCancellationIsLocal,TestSharedProviderSlowOpenIsLocal,TestManagerAcquireContextDoesNotOwnProvider`; `shared_provider_blocking_test.go:TestSharedProviderBlockedSessionWriterDoesNotStallAnotherSession,TestOpenSessionWriteCancellationIsLocal,TestSharedProviderWriteFailureOnlyRollsBackOwningSession`; `process_send_finite_test.go:TestProcessSendFiniteDeadlineBoundedQueueAndWriterReap,TestProcessSendDeadlineIncludesSubstantialQueueWait`.

3. **Provider death finishes every attached session, each with its own terminal frame**: one
   shared provider process serves many logical sessions; its death emits a `pi_eof` error frame
   per session carrying the exit summary, then the manager restarts the provider and reopens
   each durable session path. Decode errors preserve kind attribution
   (`TestSharedProviderTerminationPreservesDecodeAndIntentionalKinds`).
   Sources: `shared_provider_test.go:TestManagerSharesOneProviderAndDemultiplexesSessions,TestSharedProviderDeathFinishesEveryAttachedSession,TestManagerRestartsProviderAndReopensDurableSessionPath`; `process_test.go:TestSessionPiEOFMessageCarriesExitSummary`; `shared_provider_blocking_test.go:TestSharedProviderTerminationPreservesDecodeAndIntentionalKinds,TestManagerProviderDeathEvictsWhileLifecycleDeliveryBlocked`.

4. **Reaping is exactly-once and exit attribution is never invented**: every close path (pump
   EOF reap, `Session.Close`, `Manager.Stop`) converges on `Process.Close`; `cmd.Wait` runs
   exactly once (second caller gets the cached result). Exit summaries preserve raw
   signal/code; explicit close = "cancelled by session_close"; parent cancel beats a later
   close; concurrent close/exit races report "ambiguous" with raw evidence.
   Sources: `reap_evict_test.go:TestProcessCloseReapsExactlyOnce,TestProcessConcurrentCloseReapsExactlyOnce`; `process_test.go:TestProcessExitSummarySelfSignal,TestProcessExitSummarySelfCode,TestProcessExitSummaryCancelledWhileRunning,TestProcessExitSummaryParentCancel,TestProcessExitSummaryAmbiguousRace,TestProcessCloseTreatsCancellationAsSuccess,TestProcessClosePreservesUnexpectedExitFailure`.

5. **Response-before-exit race handling**: the provider may answer `open_session` and die in
   the same breath. The exit path closes `p.done` BEFORE the pending-response channels, and an
   open that raced process death must still observe the delivered response (success stays
   success). A descendant holding stdout must not mask the leader's reap
   (`inherit_stdout_test.go`), and stderr capture must never block reaping.
   Sources: `open_session_late_response_test.go:10-14,TestOpenSessionAcceptsResponseDeliveredAfterProviderDeath`; `inherit_stdout_test.go:TestProcessReapsLeaderMaskedByDescendantStdout,TestManagerEvictsOnceWhenLeaderExitMaskedByDescendant`; `process_stderr_test.go:TestProcessCapturesBoundedRotatingStderr,TestProcessInheritedStderrDoesNotBlockReap`.

6. **Open delivery-uncertain is never retried as a fallback open**: when a resumed
   `open_session` write misses its send deadline or the caller cancels, the manager must NOT
   issue a fresh open — the first command may still land later and a fallback would orphan a
   provider-side session. Caller context cancellation is local to the caller's open and never
   owns the provider.
   Sources: `open_delivery_uncertain_test.go:TestResumedOpenSendTimeoutDoesNotIssueFallbackOpen,TestResumedOpenCancellationDoesNotIssueFallbackOpen,TestOpenProviderDeathWriteWaitHonorsCallerCancellation`; `shared_provider_mass_kill_pin_test.go:TestManagerAcquireContextDoesNotOwnProvider,TestManagerRequiresProviderContextToStart`.

7. **Resume safety — prove before clear**: a failed resume NEVER overwrites the stored
   identity. Transient `session_path_in_use` rejections are retried on the identical request
   (3 attempts total, 500 ms backoff) and keep the identity; permanent rejection surfaces one
   `resume_failed` error frame and falls back to a fresh cwd-backed session while the stored
   binding stays verbatim; a dangling stored path gets exactly one doomed open attempt (the
   provider alone owns resume validity) with `dangling` + `storedIdentity` (+ scanned
   `branchCandidates`) on the error frame. Only a resume the provider actually rejects during
   Initialize clears the stale identity everywhere and re-initializes fresh — the chat must
   never brick, but never silently rebind either.
   Sources: `manager.go:21-25,74-77` (attempts/backoff/transientOpenError); `manager_resume_safety_test.go:TestAcquireAttachRetriesTransientSessionPathInUseAndKeepsIdentity,TestAcquireAttachPermanentFailureKeepsStoredIdentityAndSurfacesError,TestAcquireAttachDanglingStoredPathSurfacesErrorAndKeepsIdentity`; `manager_resume_failure_signal_test.go:TestAcquireAttachDanglingFailureSignalsRecoveryInfoAndKeepsIdentity,TestAcquireAttachMissingPathFailureKeepsDanglingFalseWhenFileExists`; `resume_recovery_test.go:TestSessionFailedResumeClearsIdentityAndInitializesFresh,TestSessionCancelledResumeClearsIdentity`; `api:ws_contracts_test.go:TestWebSocketPersistedResumeFailureInitializesFreshWithoutRebinding`.

8. **Resume-before-queries ordering on (re)connect**: the first provider RPC is
   `open_session` carrying the stored `sessionPath`, strictly before `get_state`,
   `get_available_models`, `get_commands`, and `get_entries`. Eager resume identity is
   delivered by the manager, and a replayed identity failure removes the session.
   Sources: `api:ws_contracts_test.go:TestWebSocketReconnectResumesIdentityBeforeQueries,TestWebSocketPersistsProviderResumeIdentityAcrossReload,TestWebSocketPersistsSpontaneousProviderIdentity`; `identity_gate_test.go:TestManagerDeliversEagerResumeIdentity,TestAcquireReplayedIdentityFailureRemovesSession`.

9. **Identity gate FIFO**: identities buffered before the route opens replay in arrival order
   before any pass-through delivery; `open()` holds the gate mutex for the whole replay so a
   concurrent delivery can never overtake buffered identities; downstream callback never runs
   concurrently with itself.
   Sources: `identity_gate_test.go:TestIdentityGateBuffersUntilOpen,TestIdentityGateHoldsSerializationAcrossReplay,TestIdentityGateReplaysBufferedInFIFOOrder,TestIdentityGateOpenSurfacesReplayErrors`.

10. **Exit gate buffers early death**: a provider dying during Start must never stay
    registered regardless of EOF-vs-registration scheduling; the gate buffers the notification
    and replays the eviction once the map entry exists, matching the EXACT session pointer
    (a replaced session is spared).
    Sources: `exit_gate_test.go:TestExitGateBuffersUntilOpen,TestExitGateReplayEvictsExactRegisteredSession,TestExitGateReplaySparesReplacement,TestManagerStartNeverKeepsDeadSession`.

11. **Idle eviction semantics**: only finished sessions that are idle past `idleFor`
    (30 min default) with zero attachments are swept; acquire always reuses/replaces atomically
    (sweeper never races an in-flight acquire); eviction emits EXACTLY ONE
    `error{code:"session_unloaded"}` frame; the evicted session's stored identity is reopened on
    next acquire; sibling routes keep working; unknown/detached handles evict nothing else;
    compaction must not wedge eviction; a requested close resolves only its own pending
    request. Detaching the last client keeps the process alive and reusable (reacquire returns
    the same session); active sessions are never reaped; reap still guards explicit cleanup.
    Sources: `manager.go` (`idleFor`, `sweep`); `idle_eviction_test.go:TestIdleEvictionRemovesSessionAndReopensStoredIdentity,TestIdleEvictionAcquireWaitsForAtomicRouteEviction,TestIdleEvictionEvictsBeforePersistenceDrainAndReopensStoredIdentity,TestIdleEvictionEmitsExactlyOneSessionUnloadedError,TestRequestedCloseSessionResponseOnlyResolvesPendingRequest,TestIdleEvictionForUnknownOrDetachedHandleLeavesSiblingUntouched,TestSiblingRoutesCommandAfterIdleEviction`; `detached_runtime_test.go:TestSessionDetachKeepsProcessAlive,TestManagerAcquiresExistingSessionBeforeSweeper,TestManagerReapSkipsAttachedFinishedSession,TestManagerSweepsIdleFinishedSessionWithoutReopen,TestManagerFinishedSessionStaysReusableBeforeIdleTimeout,TestManagerActiveSessionIsNotReaped,TestManagerReapFinishedStillGuardsExplicitCleanup`; `compact_lifecycle_test.go:TestCompactionDoesNotWedgeIdleEviction`.

12. **Broadcast bounds**: each cancellable subscriber has a bounded outbound FIFO
    (`subscriberQueueSize == sessionQueueSize == 64`). On overflow the slow subscriber is
    detached — its wedged `WriteJSON` released via the `FrameWriterCanceller.Close` contract —
    WITHOUT killing the session or stalling siblings; the overflow-detach must fire strictly
    before the route queue would overflow and kill the session. Per-subscriber frame order is
    preserved; a healthy in-flight write survives detach; the route worker can never be
    stalled into a queue-overflow session kill by a slow client; release-orphan cleanup has no
    leaks under concurrent detach/close.
    Sources: `broadcaster.go:19-28,150-161`; `broadcaster_overflow_test.go:TestBroadcasterDetachesSlowSubscriberWithoutKillingSession,TestBroadcasterLongBlockedSubscriberSurvivesDefaultDeadline,TestBroadcasterDeliveryTimeoutDoesNotKillSession,TestBroadcasterPreservesPerSubscriberFrameOrder,TestHealthyInFlightWriteSurvivesDetach,TestReleaseOrphansNoLeakUnderConcurrentDetachClose,TestConcurrentDetachCloseReleasesWedgedWriter,TestDetachReleasesWedgedSubscriberItRemoves,TestWatchdogDetachesEvenWhenCancelledWriteReturnsNil`.

13. **Route queue bound and lifecycle-delivery decoupling**: the per-session route queue is
    bounded at `sessionQueueSize` (64); queue overflow while lifecycle delivery is blocked
    must not stall the provider pump; a queued route drains its frames BEFORE the terminal
    frame; provider exit between open and registration rejects the stale session, and
    registration is refused while the provider is closing; a close-response timeout cleans the
    route and leaves siblings writable.
    Sources: `shared_provider_route.go:10`; `shared_provider_lifecycle_test.go:TestSharedProviderQueueOverflowWhileLifecycleDeliveryBlockedDoesNotStallPump,TestSharedProviderBlockedWriterDoesNotTearDownSession,TestSharedProviderFailedStartAndConcurrentLastReleaseAreSafe,TestSharedProviderCloseResponseTimeoutCleansRouteAndLeavesSiblingWritable,TestManagerProviderExitBetweenOpenAndRegistrationRejectsStaleSession,TestManagerRegistrationRefusedWhileSharedProviderClosing,TestSessionRouteDrainsQueuedFramesBeforeTerminalFrame,TestManagerLockOrderAllowsProviderExitDuringBlockedSweepAcquireAndClose`; `shared_provider_preopen_test.go:TestSharedProviderDeliversTaggedNoticeEmittedBeforeOpenResponse,TestSharedProviderPreOpenEventBufferDropsNewestAtRouteQueueBound`.

14. **Notice lifecycle gating**: exactly six advisory kinds are durable (`retry_fallback_applied`,
    `retry_fallback_reverted`, `retry_fallback_succeeded`, `retry_fallback_exhausted`,
    `server_fallback_aborted`, `high_reasoning_warning`): logged on the session (bounded at 50,
    oldest dropped), replayed to EVERY later attach, and persisted via `OnNoticePersist`.
    Everything else — including `extension_notify` — is transient: broadcast once, never
    logged, never persisted, never replayed. Every notice frame carries an RFC3339Nano `at`
    receipt time. Log append + live broadcast commit under the delivery barrier so a
    concurrent attach can never replay a log missing a notice it is about to receive live.
    Advisory forwarding must not alter approval_select handling; pre-open tagged notices are
    delivered to the right route.
    Sources: `notice_durable.go:13-22`; `notice_durable_test.go:TestNoticeFramesCarryReceiptTime,TestDurableNoticesLogAndTransientDoNot,TestDurableNoticeLogDropsOldest,TestAttachReplaySnapshotsThenDurableNotices,TestTransientNoticesNeverReplayed*` (in `notice_forward_test.go:TestTransientNoticesNeverReplayedToLateSubscriber`), `notice_forward_test.go:TestAdvisoryEventsForwardedAsNotice,TestExtensionNotifyForwardedAsNotice,TestApprovalSelectUnchangedByNoticeForwarding`; `shared_provider_preopen_test.go:TestSharedProviderDeliversTaggedNoticeEmittedBeforeOpenResponse`.

15. **Notice persistence is write-through, deduped, and generation-safe**: fired once per
    durable notice with the full log; unchanged logs are never rewritten (changed-guard); a
    failed write retries with the full log and never advances the dedup marker; slow/stalled
    persistence never blocks dispatch (final log flushed on drain); generation leases let disk
    I/O proceed without `Manager.mu` while a retired worker can never overwrite a replacement
    generation; identical durable notices get distinct persisted replay IDs; malformed seeded
    records are tolerated; provider exit stops the worker; close drains the worker.
    Sources: `notice_durable_test.go:TestOnNoticePersistWriteThroughAndChangedGuard,TestSlowNoticePersistenceWritesEveryAppendSnapshotInOrder,TestStalledNoticePersistenceDoesNotBlockDispatchAndFlushesFinalLog,TestIdenticalDurableNoticesHaveDistinctPersistedReplayIDs,TestCloseDrainsNoticePersistenceWorker,TestPersistenceGenerationLeaseDoesNotBlockManagerAndRetirementWaits,TestManagerRetainsPersistenceGenerationThroughDisconnectDrain,TestProviderExitStopsNoticePersistenceWorker,TestRetiredWorkerCannotOverwriteReplacementGeneration,TestNoticePersistenceRegistrationWindowRetriesAfterRouteActivation,TestSeedNoticesReplayToFirstClient,TestSeedNoticesDropsMalformedRecords,TestFailedActivityPersistRetriesSamePair`; `api:notice_durable_test.go:TestDurableNoticePersistsToChatRecord,TestMalformedSeededNoticesTolerated`.

16. **Run/compaction lifecycle gating (latched under lifecycleMu, provider write outside
    locks)**: a prompt is rejected (`prompt_in_flight`) while any run is active — user run,
    provider wake run (`providerRunActive`), or live compaction (`compaction_in_flight`); a
    run completes ONLY on the provider's settle event (stale settles ignored, duplicate starts
    arm one run); on send failure the gate clears only if the prompt sequence still matches
    (stale failures never roll back a newer prompt); automatic compaction during a run does
    not complete the run; compaction_start/compaction_done map to `compaction.started`/
    `compaction.done` EXACTLY ONCE, stale compact responses never clear a newer compaction,
    a failed response without end still clears the latch, and a successful response closes the
    transaction; terminal publication holds the lifecycle lock, but no lifecycle lock is held
    across the provider write (a stopped-reading provider must never block Close/reaping).
    Sources: `session_commands.go:SendPrompt,Compact` (check-and-latch + sequence-guarded rollback); `release_blockers_test.go:TestSessionPromptInFlightGate,TestSessionPromptWriteFailureRestoresIdleFinished,TestStalePromptWriteFailureDoesNotRollbackNewPrompt,TestSessionPromptGateClearsOnSendFailure`; `compact_lifecycle_test.go:TestCompactStandaloneLifecycleAgainstMock,TestCompactRejectsWhileRunActive,TestCompactRepeatAndPromptGateWhileInFlight,TestCompactSendFailureClearsAndStamps,TestAutomaticCompactionDuringRunDoesNotCompleteRun,TestCompactionEventsEmitFramesExactlyOnce,TestStaleCompactResponseAndEndDoNotClearNewerCompact,TestFailedCompactResponseWithoutEndClearsLatch,TestSuccessfulCompactResponseClosesTransaction,TestCompactionStartWaitsForLifecycleLock,TestCompactionTerminalPublicationHoldsLifecycleLock,TestCompactDoesNotHoldLifecycleLockAcrossProviderWrite`; `omo_lifecycle_test.go:TestOmoNormalPromptCompletesOnlyOnAgentSettled,TestOmoDuplicateAgentStartArmsOneRun,TestOmoStaleSettledWithoutArmedRunIsIgnored,TestOmoRejectsPromptDuringProviderWakeRun,TestOmoTerminalPublicationHoldsLifecycleLock,TestOmoProviderStartWaitsForLifecycleLock,TestOmoRejectedPromptRecordsFinishedAt,TestOmoWakeRunEmitsRunStartedThenRunDone,TestOmoFollowOnAgentStartAfterSettledOpensNewRun,TestOmoFinishedStateTracksProviderRun,TestOmoPromptAndSkillInvocationsStayArmedUntilSettled`.

17. **Extension events are capability-gated and snapshot-disciplined**: the host injects
    `SENPI_RPC_CLIENT_CAPABILITIES=extension_events` at session start and never bypasses the
    gate; events forward verbatim (name + data), nameless ones are dropped; events whose
    parent tag mismatches the session are dropped (parent filtering allows tagged-before-ID,
    matching runtime ID, and absent parent); activity snapshots (`omo.task.updated`,
    `omo.dag.updated`) replay to late subscribers — snapshot replay strictly precedes any
    following live frame — while transient activity (`omo.dag.activity`, `omo.dag.heartbeat`)
    is never cached or replayed; oversized snapshots are forwarded but not cached (live flag
    semantics); refresh routes the snapshot to the requesting attachment FIFO; seeded
    (persisted) snapshots replay to the first client and are superseded name-by-name by live
    ones; run settle is the activity persistence boundary with reconcile-before-publish
    (terminal dag runs demote ghost running tasks; late tasks reconcile before `run.done` so a
    refresh can never replay a contradictory pair); oversized digests truncate/cap without
    poisoning (malformed shapes/JSON keep the previous digest).
    Sources: `extension_event_test.go:TestExtensionEventForwardedToClients,TestExtensionEventNamelessDropped,TestExtensionEventSnapshotsReplayedToLateSubscriber,TestActivitySnapshotReplayPrecedesFollowingLiveFrame,TestActivityRefreshUsesRequestingAttachmentFIFO,TestExtensionEventTransientActivityNotReplayedOnAttach,TestExtensionEventOversizedSnapshotForwardedNotCached,TestStartSessionInjectsExtensionEventsCapability`; `provider_routing_isolation_test.go:TestForwardExtensionEventDropsMismatchedParent,TestForwardExtensionEventAllowsMatchingParent,TestForwardExtensionEventMatchesRuntimeIDWhenResumeIdentityIsFile,TestForwardExtensionEventAllowsTaggedParentBeforeRuntimeIDCapture,TestForwardExtensionEventAllowsAbsentParent,TestTwoSessionIsolationAfterProviderRestart,TestTwoSessionIsolationDuringConcurrentProviderRestart,TestProviderDeathClearsSharedAndHandle`; `activity_snapshot_seed_test.go:TestSeedActivitySnapshotsReplayToFirstClient,TestLiveSnapshotSupersedesSeededSnapshot,TestRunCompletionPersistsActivityPair,TestSettleDemotesTasksOfTerminalDagRuns,TestSettleReconcilesLateTaskBeforeRunDone,TestSessionCloseWaitsForActivityPersistence`; `activity_snapshot_oversized_test.go:TestOversizedActivitySnapshotReportsLiveFlagAndLeavesCacheUnchanged,TestInCapActivitySnapshotAfterOversizedClearsLiveFlag`; `activity_digest_test.go:TestActivityDigestMalformedShapesKeepPreviousDigest,TestActivityDigestMalformedJSONKeepsPreviousDigest,TestActivityDagDigestCapsTotalRunningTaskIDs,TestActivityTaskDigestTruncatesPast512Entries`; `activity_reconcile_test.go:TestReconcileActivityPairPreservesTerminalNodeOutcomes,TestReconcileActivityPairReturnsUnchangedPairByteIdentical`; `api:ws_refresh_test.go:TestWebSocketActivityRefreshPullsSnapshotToRequestingClient,TestWebSocketActivityRefreshWithoutSession`.

18. **Entries are paged with hard bounds and an always-present Final flag**: pages cap at 100
    entries or 256 KiB (an oversized entry owns its own page); every `entries` frame carries
    `final` (false until the terminal page, which also carries `leafId`); an empty array still
    yields one `final:true` frame; malformed entries data still completes history; streamed
    pages arrive in order (single pump goroutine); a failed `get_entries` is never streamed as
    success; malformed outer tail suppresses the terminal frame.
    Sources: `entries_paging.go:6-10`; `entries_paging_test.go:TestChunkEntriesCountBound,TestChunkEntriesByteBound,TestChunkEntriesOversizedEntryOwnPage,TestSendEntriesPagedLargePayloadSplit,TestSendEntriesPagedEmptyOversizedArray,TestSendEntriesPagedSmallPayloadSingleFrame,TestSendEntriesMalformedDataCompletesHistory`; `entries_stream_test.go:TestSessionOmoHistoryStreamsThroughPump`; `process_stream_test.go:TestStreamFrames_MalformedIsFatal,TestStreamFrames_MalformedOuterTailSuppressesTerminal,TestStreamFrames_FailedGetEntriesNotStreamed,TestStreamFrames_CompositeLeafIdDoesNotDesync,TestStreamFrames_GetEntriesExceedsOldLineCap`.

19. **Control-command acks precede results and are request-correlated**: an acceptance `ack`
    (carrying the client `requestId`) is emitted immediately and always precedes the later
    typed `control_result` (delivered through the session barrier); approval ack is ordered
    before the resumed stream; ack order follows acceptance order (set_model before
    set_thinking); a mismatched sessionId is rejected without side effects; control-before-
    session commands error without an ack. Commands discovery forwards the provider's real
    schema (get_commands entries with source/syntax/sourceInfo), normalized through response
    mapping.
    Sources: `api:ws_ack_test.go:TestWebSocketControlAcksFollowAcceptedSets,TestWebSocketApprovalAckOrderedBeforeResumedStream,TestWebSocketControlBeforeSessionErrorsWithoutAck,TestWebSocketSetModelAckCarriesRequestIDAndPrecedesResult,TestWebSocketSessionMismatchIsRejectedWithoutSideEffect`; `contracts_test.go:TestSessionControlResultsAreTypedAndCorrelated,TestSessionForwardsLiveCustomMessageType`; `commands_changed_test.go:TestCommandsChangedForwardsProviderInventory,TestCommandsFrameCarriesRealOmoSchema`; `provider_rpc_test.go:TestSessionResponseCommandsNormalizeCommandsFrame,TestSessionResponseHistoryNormalizeEntriesFrame`.

20. **API-layer lifecycle serialization**: connection-handler state is synchronized across
    close, reconnect, and session replacement; chat create/delete cannot orphan a session
    (a create that races a winning delete tears itself down after rechecking the store);
    provider shutdown I/O stays OUTSIDE `chatLifecycleMu`; deleting a workspace serializes
    with chat create and stops every active chat; chat open is bounded by a 15 s timeout and a
    disconnect/lifecycle-blocked open must not block another lifecycle operation; opening
    touches `last_used_at`; every non-create/ping WS frame must target the socket-bound chat
    (`session_mismatch` otherwise), with `activity.refresh` exempt when unbound.
    Sources: `api:release_blockers_test.go:TestConnHandlerAccessIsSynchronizedWithClose,TestChatCreateAndDeleteLifecycleCannotOrphanSession,TestDeleteWorkspaceSerializesCreateAndStopsEveryActiveChat,TestListWorkspacesProjectsLegacyChatsWithoutWrites`; `api:router.go` (`chatOpenTimeout`); `api:chat_open_timeout_test.go:TestChatOpenDisconnectDoesNotBlockAnotherLifecycleOperation`; `api:chat_open_mru_test.go:TestChatOpenTouchesLastUsedAt`; `api:chat.go:routeMessage` (session-mismatch gate).

21. **Naming precedence and creation contract**: user rename always wins — auto-title never
    overrides it and a provider name event keeps the user rename; provider name events replace
    only auto titles; rename marks `NameSource:"user"` and forwards best-effort to the live
    provider; slash prompts produce no auto title (next plain prompt does). Chat creation
    payload is `{name, provider}` — NO model selection at create — provider must resolve to
    `omo` (legacy empty/`senpi` records launch as omo without persisting the alias; unsupported
    records are rejected verbatim); availability is checked via the configured runner; a
    chat creation rejects `resumeIdentity`; discovered sessions activate exclusively through the
    verified-copy adoption endpoint; legacy unprovenanced cursors are migrated at the manager
    flight before first open. Sessions detach-process-alive across manager reuse;
    `LiveSummaries` returns process-alive sessions sorted by ID.
    Sources: `api:chat_name_api_test.go:TestAutoTitleTitlesChat_whenFirstPlainPromptSent,TestAutoTitleSkipsSlashPrompt_thenTitlesNextPlainPrompt,TestAutoTitleNeverOverridesUserRename`; `api:chat_rename_api_test.go:TestRenameChatMarksUserSource_andForwardsToLiveProvider,TestProviderNameEventReplacesAutoTitle,TestProviderNameEventKeepsUserRename`; `session_name_test.go:Test_session_info_changed_emits_name_frame_and_callback,Test_set_session_name_failure_emits_no_error_frame`; `title_test.go:Test_DeriveSessionTitle`; `api:chat_create_test.go:TestCreateChatRejectsResumeIdentity,TestCreateChatPersistsExplicitProviderWithoutModel,TestCreateChatRequiresSupportedProvider,TestCreateChatRejectsUnavailableProvider`; `api:session_adoption_test.go:TestAdoptWorkspaceSessionCreatesOwnedChatWithoutTouchingOriginal,TestAdoptWorkspaceSessionIsIdempotentAndCatalogMarksSource`; `test/cutover/e2e_test.go:TestAdoptionHTTPToBridgePreservesOriginalThroughCompletedTurn`; `api:chat_launch_provider_test.go:TestChatCreateRejectsUnsupportedPersistedProvider,TestChatCreateLaunchesLegacyProviderChatsAsOmo`; `provider_test.go:TestNormalizePersistedProvider,TestNormalizePersistedProviderResultIsLaunchable`; `AGENTS.md` (anti-pattern: no model selection at create, no multiplexer); `manager_live_test.go:TestManagerLiveIDsReturnsSortedAliveSessions`.

22. **Process group and stderr discipline**: on close or context cancel the ENTIRE process
    group is killed (no orphaned descendants); stderr is captured to a bounded rotating file
    (never unbounded); a failed start never spawns the writer goroutine; natural EOF reaps the
    writer; concurrent send/close fails fast and still reaps.
    Sources: `process_group_unix_test.go:TestProcessCloseKillsEntireGroup,TestProcessContextCancelKillsEntireGroup`; `process_stderr_test.go:TestProcessCapturesBoundedRotatingStderr`; `process_writer_lifecycle_test.go:TestProcessFailedStartDoesNotSpawnWriter,TestProcessNaturalEOFReapsWriter,TestProcessConcurrentSendCloseFailsFastAndReapsWriter`; `api:chat_lifecycle_stderr_test.go:TestProviderStderrPathUsesEffectiveStateDir,TestChatProviderStderrUsesStateDir`.

## ROUTE PARITY TABLE

All v1 routes from `internal/api/router.go`. v2 must keep the external HTTP contract unless
marked otherwise — the SPA and the WS bridge depend on it. Nothing is dropped: every route is
either engine-independent (fs/layout/system/auth) or is the only chat-control surface.

| # | Route | What it does (v1) | v2 verdict |
|---|-------|-------------------|------------|
| 1 | `POST /api/login` | Public password login; sets auth session cookie (public, before middleware) | KEEP |
| 2 | `POST /api/logout` | Destroys auth session | KEEP |
| 3 | `GET /api/auth/check` | Auth probe for SPA bootstrap | KEEP |
| 4 | `GET /api/workspaces` | List workspaces (legacy chats projected read-only, no writes) | KEEP |
| 5 | `POST /api/workspaces` | Create workspace | KEEP |
| 6 | `DELETE /api/workspaces/{wsId}` | Delete workspace; serializes with chat create and stops every active chat (invariant 20) | KEEP |
| 7 | `PATCH /api/workspaces/{wsId}` | Rename workspace | KEEP |
| 8 | `GET /api/workspaces/{wsId}/sessions` | List sessions discoverable in workspace history scan (incl. dangling/branch handling) | KEEP |
| 9 | `POST /api/workspaces/{wsId}/chats` | Create chat `{name, provider}`; `resumeIdentity` is rejected; provider normalized to omo (invariant 21) | KEEP; discovered sessions activate only through the verified-copy adoption endpoint, with legacy unprovenanced cursors migrated at the manager flight before first open |
| 10 | `DELETE /api/workspaces/{wsId}/chats/{chatId}` | Remove chat record; `Stop`s the session; provider I/O outside `chatLifecycleMu` (invariants 20, 22) | KEEP |
| 11 | `PATCH /api/workspaces/{wsId}/chats/{chatId}` | Rename chat; marks `NameSource:"user"`; forwards best-effort to live provider (invariant 21) | KEEP |
| 12 | `POST /api/workspaces/{wsId}/chats/{chatId}/upload` | Upload file into workspace cwd | KEEP |
| 13 | `GET /api/providers` | Provider inventory + binary availability via configured runner | KEEP |
| 14 | `GET /api/sessions/live` | Process-alive session summaries (title, cached activity pair, oversized flags, digests) | REDESIGN — external shape kept, but the data source moves from in-process manager state to the RPC engine; keep ID ordering + digest semantics (invariants 17, 21) |
| 15 | `GET /api/ws` | WebSocket bridge: origin-checked upgrade, permessage-deflate, SPA frame transport | KEEP external contract; internals are the v2 rewrite itself (RPC client replaces process pump; deflate + origin check preserved — `api:ws_deflate_test.go`, `ws.go:wsOriginAllowed`) |
| 16 | `GET /api/fs/browse` | Browse filesystem for workspace picker | KEEP (engine-independent) |
| 17 | `GET /api/fs/list` | List directory entries | KEEP (engine-independent) |
| 18 | `GET /api/fs/download` | Download file from workspace | KEEP (engine-independent) |
| 19 | `GET /api/fs/read` | Read file contents | KEEP (engine-independent) |
| 20 | `GET /api/fs/search` | Search files in workspace | KEEP (engine-independent) |
| 21 | `POST /api/fs/write` | Write file in workspace | KEEP (engine-independent) |
| 22 | `POST /api/fs/mkdir` | Create directory in workspace | KEEP (engine-independent) |
| 23 | `GET /api/layout` | Read saved UI layout | KEEP (engine-independent) |
| 24 | `PUT /api/layout` | Save UI layout | KEEP (engine-independent) |
| 25 | `GET /api/system/stats` | Host/system stats for the dashboard | KEEP (engine-independent) |

Engine-adjacent helper behavior that must survive with routes 9-11: 1 MiB JSON body cap
(`decodeJSON`), store sentinel mapping (404 `ErrNotFound`, 409 `ErrDuplicate`, 500 otherwise),
and the embedded-SPA static handler with immutable `assets/` caching + no-cache `index.html`
fallback (`router.go`).

## WS MESSAGE SURFACE

The frame contract v1 forwards between the RPC engine and the SPA (v2's input list;
`internal/chat/protocol.go`, `internal/api/chat.go:routeMessage`, pinned by `contracts_test.go`
and the `ws_*_test.go` suite).

Server -> SPA (engine/manager to client):

- `ready` — `{sessionId, piSessionId, resumed}`; emitted after open/resume.
- `message.delta` — streaming assistant delta `{messageId?, delta{kind, contentIndex, delta?, content?, reason?, partial?}}`.
- `message` — completed assistant message `{message{role, customType?, blocks[], model?, usage?, ts?}}`.
- `tool` — tool lifecycle `{toolCallId, toolName, phase, args?, partial?, result?, isError?}`.
- `state` — session state snapshot `{model?, thinkingLevel?, isStreaming, isCompacting, sessionName?, messageCount?}`.
- `name` — session name change `{name, origin: auto|user|provider}` (invariant 21).
- `stats` — `{tokens?, cost?, contextUsage?}`.
- `approval` — approval request `{id, method, title?, message?, options?, prefill?, placeholder?, timeout?}`.
- `commands` — get_commands inventory in Omo's real schema `{commands[{name, description?, source?, syntax?, sourceInfo?}]}` (invariant 19).
- `entries` — paged history `{entries, leafId?, final}` — `final` on every frame, bounds per invariant 18.
- `models` — available models `{models[{provider, modelId, name?, input?}]}`.
- `run.started` — a run began (client prompt or provider wake turn).
- `run.done` — run settled `{reason}` (only after agent_settled per invariant 16).
- `compaction.started` — compaction began (manual|threshold|overflow).
- `compaction.done` — terminal compaction frame `{error?}` — exactly one per compaction (invariant 16).
- `control.result` — typed outcome of set_model/set_thinking `{command, requestId?, success, message?}`; always after the acceptance ack (invariant 19).
- `ack` — API-level acceptance ack `{command, requestId}` (set_model, set_thinking, approval respond, extension_ui_response).
- `extensionEvent` — capability-gated passthrough `{name, data?}`; cached snapshots (`omo.task.updated`, `omo.dag.updated`) replay on attach before live frames; `omo.dag.activity`/`omo.dag.heartbeat` never cached (invariant 17).
- `notice` — advisory `{kind, payload, at, nid?}`; durable kinds replay + persist, transient kinds fire once (invariants 14-15).
- `error` — typed errors `{code, message, command?, requestId?}` with codes including: `pi_eof` (carries exit summary), `resume_failed` (+`dangling`, `storedIdentity`, `branchCandidates`), `session_unloaded`, `session_mismatch`, `prompt_in_flight`, `compaction_in_flight`, `provider_error`, `persist_failed`, `decode_failed`, `bad_frame`, `unknown_type`, `bad_create`, `bad_provider`, `no_workspace`, `no_chat`, `start_failed`, `initialize_failed`, `provider_overflow`, `provider_timeout`, `bad_approval`, `bad_resume`, `bad_send`, `bad_set`, `no_session`, `send_failed`, `compact_failed`.
- `pong` — reply to `ping`.

Client -> SPA server (decoded ONLY through `ParseClientFrame` — keep this chokepoint in v2):

- `ping` — liveness; answered by `pong` without a session.
- `chat.create` — `{wsId, chatId}`: bind socket to a chat (the only frame that may run before a session is bound).
- `chat.send` — user prompt (+ optional `images`); refused while run/compaction active (invariant 16).
- `chat.abort` — abort current run (fire-and-forget `abort` to provider).
- `chat.set` — set model / thinking level; acks with `requestId` then `control.result`.
- `approval.respond` — answer an approval request (ack ordered before resumed stream).
- `chat.commands` — request commands inventory (`commands` frame back).
- `chat.compact` — dedicated compaction RPC, never a "/compact" prompt.
- `chat.models` — request available models.
- `chat.stats` — request token/cost stats.
- `activity.refresh` — pull latest activity snapshot to requesting client; exempt from the session-mismatch gate when no chat is bound (invariant 20).
- `chat.resume` — resume from identity.
- `chat.close` — detach socket from chat, session process stays alive (invariant 11).
- `chat.disconnect` — detach AND `Stop` the chat's session.
- anything else -> `error{code:"unknown_type"}`; malformed JSON -> `error{code:"bad_frame"}`.

Transport notes to preserve: permessage-deflate negotiation is deliberate (multi-megabyte
history replay dominates latency); origin check = exact-host http/https, single Origin header,
no userinfo/path/query; oversized WS write failures are logged and surfaced, never silently
dropped (`api:chat.go:WriteJSON`, `api:ws_deflate_test.go:TestWebSocketNegotiatesPermessageDeflate`).
