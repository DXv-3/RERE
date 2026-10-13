import {
  CHECKIN_STATUS_LABEL,
  applyReviewed,
  arrangeCheckIns,
  checkInsWaitingLabel,
  checkRedirectNote,
  goalTitleFor,
  type CheckInFilter,
} from "@t3tools/client-runtime/operations/agent-check-ins";
import { goalErrorMessage, goalErrorReason } from "@t3tools/client-runtime/operations/agent-goals";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AGENT_CHECKIN_NOTE_MAX,
  ThreadId,
  type AgentCheckIn,
  type AgentCheckInFilter,
  type WorkspaceAgent,
} from "@t3tools/contracts";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentAvatar } from "./AgentAvatar";
import { ageLabel } from "./agentGoalsLogic";
import { ActionButton } from "./components/ActionButton";
import { ClampedText } from "./components/ClampedText";
import { FormField } from "./components/ScheduleFields";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

type ReviewAction = "approve" | "redirect" | "dismiss";

const NONE: ReadonlyArray<never> = [];
const PENDING: AgentCheckInFilter = { status: "pending" };
const EVERYTHING: AgentCheckInFilter = {};

/**
 * Everything the agents have reported on their goals. What waits for you comes first; approve it,
 * dismiss it, or redirect the agent with a note that becomes its next instruction.
 */
export function SettingsCheckInsRouteScreen() {
  const { selectedTargets, availableTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<CheckInFilter>("waiting");
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const update = () => setNow(Date.now());
      update();
      const timer = setInterval(update, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") update();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, []),
  );

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Check-Ins" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <SegmentedControl
            options={[
              { value: "waiting" as const, label: "Waiting" },
              { value: "all" as const, label: "All" },
            ]}
            selected={filter}
            onSelect={setFilter}
          />
          {selectedTargets.length > 0 ? (
            selectedTargets.map((environment) => (
              <EnvironmentCheckIns
                key={environment.environmentId}
                environment={environment}
                filter={filter}
                now={now}
                showTitle={selectedTargets.length > 1}
              />
            ))
          ) : (
            <Text accessibilityRole="alert" className="px-2 text-base text-foreground-muted">
              {availableTargets.length === 0
                ? "Connect to your agent workspace to see check-ins."
                : "No environments match these filters. Change the filter above."}
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function EnvironmentCheckIns(props: {
  readonly environment: SettingsTarget;
  readonly filter: CheckInFilter;
  readonly now: number;
  readonly showTitle: boolean;
}) {
  const { environmentId } = props.environment;
  const pending = useEnvironmentQuery(
    serverEnvironment.agentCheckInsLive({ environmentId, input: PENDING }),
  );
  // The full history is only subscribed to while the All switch is on.
  const all = useEnvironmentQuery(
    props.filter === "all"
      ? serverEnvironment.agentCheckInsLive({ environmentId, input: EVERYTHING })
      : null,
  );
  // Archived agents stay in the list: their old check-ins still show.
  const agentList = useEnvironmentQuery(serverEnvironment.agentList({ environmentId, input: {} }));
  const agents = agentList.data ?? NONE;
  // Until the agent list arrives (or fails) names and goal titles are unknown, not deleted.
  const agentsKnown = agentList.data !== null;
  const navigation = useNavigation();
  const review = useAtomCommand(serverEnvironment.agentCheckInsReview, { reportFailure: false });
  // Reviewed here a moment ago; shown at once rather than when the server's next list arrives.
  const [reviewed, setReviewed] = useState<Readonly<Record<string, AgentCheckIn>>>({});
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});

  const pendingItems = applyReviewed(pending.data?.checkIns ?? NONE, reviewed);
  const allItems = applyReviewed(all.data?.checkIns ?? NONE, reviewed);
  const waitingCount = pendingItems.filter((checkIn) => checkIn.status === "pending").length;
  const items = arrangeCheckIns({ filter: props.filter, pending: pendingItems, all: allItems });
  const loading =
    (pending.data === null && pending.error === null) ||
    (agentList.data === null && agentList.error === null) ||
    (props.filter === "all" && all.data === null && all.error === null);
  const error = pending.error ?? (props.filter === "all" ? all.error : null);
  const retry = () => {
    pending.refresh();
    if (props.filter === "all") all.refresh();
  };

  const submit = async (
    checkIn: AgentCheckIn,
    action: ReviewAction,
    note?: string,
  ): Promise<boolean> => {
    setWorking((current) => new Set(current).add(checkIn.id));
    setErrors(({ [checkIn.id]: _cleared, ...rest }) => rest);
    const result = await review({
      environmentId,
      input: { id: checkIn.id, action, ...(note ? { note } : {}) },
    });
    setWorking((current) => {
      const next = new Set(current);
      next.delete(checkIn.id);
      return next;
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      const failure = squashAtomCommandFailure(result);
      if (goalErrorReason(failure) === "already_reviewed") {
        // Someone else got there first. Reload and let the list show the outcome.
        retry();
        return false;
      }
      setErrors((current) => ({ ...current, [checkIn.id]: goalErrorMessage(failure) }));
      return false;
    }
    setReviewed((current) => ({ ...current, [checkIn.id]: result.value }));
    return true;
  };

  const summary =
    loading && pending.data === null
      ? "Loading Check-Ins…"
      : waitingCount === 0
        ? "Nothing Waiting"
        : checkInsWaitingLabel(waitingCount, pending.data?.nextCursor != null);
  const empty = !loading && !error && items.length === 0;
  return (
    <View className="gap-2">
      {props.showTitle ? (
        <Text className="px-2 text-sm font-t3-medium text-foreground-muted">
          {props.environment.label}
        </Text>
      ) : null}
      <Text
        accessibilityLiveRegion="polite"
        className="px-2 text-base font-t3-medium text-foreground"
      >
        {summary}
      </Text>
      {error ? (
        <View className="gap-2 rounded-2xl bg-grouped-card p-4">
          <Text accessibilityRole="alert" className="text-base text-danger-foreground">
            Could not load check-ins. {error}
          </Text>
          <ActionButton label="Try Again" onPress={retry} />
        </View>
      ) : null}
      {empty ? (
        <View className="gap-1 rounded-2xl bg-grouped-card p-4">
          <Text className="text-base font-t3-medium text-foreground">
            {props.filter === "waiting" ? "Nothing Waiting" : "No Check-Ins Yet"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {props.filter === "waiting"
              ? "Every check-in has been reviewed."
              : "When an agent finishes a turn on one of its goals, its report lands here."}
          </Text>
        </View>
      ) : null}
      {items.length > 0 ? (
        <SettingsSection>
          {items.map((checkIn, index) => (
            <CheckInCard
              key={checkIn.id}
              checkIn={checkIn}
              first={index === 0}
              now={props.now}
              agent={agents.find((entry) => entry.profile.id === checkIn.agentId)}
              agentsKnown={agentsKnown}
              goalTitle={goalTitleFor(agents, checkIn)}
              working={working.has(checkIn.id)}
              error={errors[checkIn.id] ?? null}
              onReview={(action, note) => submit(checkIn, action, note)}
              onOpen={(agent) => {
                if (agent.primaryThreadId)
                  navigation.navigate("Thread", {
                    environmentId,
                    threadId: ThreadId.make(agent.primaryThreadId),
                  });
              }}
            />
          ))}
        </SettingsSection>
      ) : null}
    </View>
  );
}

function CheckInCard(props: {
  readonly checkIn: AgentCheckIn;
  readonly first: boolean;
  readonly now: number;
  readonly agent: WorkspaceAgent | undefined;
  /** False while the agent list is unavailable, when a missing agent or goal proves nothing. */
  readonly agentsKnown: boolean;
  readonly goalTitle: string | null;
  readonly working: boolean;
  readonly error: string | null;
  readonly onReview: (action: ReviewAction, note?: string) => Promise<boolean>;
  readonly onOpen: (agent: WorkspaceAgent) => void;
}) {
  const { checkIn, agent } = props;
  const [redirecting, setRedirecting] = useState(false);
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);
  const waiting = checkIn.status === "pending";
  const name = agent?.profile.name ?? (props.agentsKnown ? "Unknown Agent" : "Agent");
  const canOpen = agent !== undefined && !agent.archivedAt && agent.primaryThreadId !== null;
  const status = CHECKIN_STATUS_LABEL[checkIn.status];
  return (
    <View className={props.first ? "gap-3 p-4" : "gap-3 border-t border-border-subtle p-4"}>
      <View className="flex-row items-center gap-3">
        {agent ? <AgentAvatar profile={agent.profile} size={40} /> : null}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-lg font-t3-medium text-foreground" numberOfLines={1}>
            {name}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={2}>
            {props.goalTitle ?? (props.agentsKnown ? "Deleted Goal" : "Goal")} ·{" "}
            {ageLabel(checkIn.createdAt, props.now)}
          </Text>
        </View>
        <View className="items-end">
          <Text
            className={
              waiting
                ? "text-sm font-t3-medium text-primary-text"
                : "text-sm font-t3-medium text-foreground-muted"
            }
          >
            {status}
          </Text>
          {!waiting && checkIn.reviewedAt ? (
            <Text className="text-xs text-foreground-muted">
              {ageLabel(checkIn.reviewedAt, props.now)}
            </Text>
          ) : null}
        </View>
      </View>
      <ClampedText text={checkIn.summary} />
      {checkIn.needsFromOwner ? (
        <View className="gap-1 rounded-2xl bg-subtle p-3">
          <Text className="text-sm font-t3-medium text-foreground">Needs From You</Text>
          <ClampedText text={checkIn.needsFromOwner} lines={4} />
        </View>
      ) : null}
      {checkIn.source === "fallback" ? (
        <Text className="text-sm text-foreground-muted">
          Written By The Server. The agent filed no report of its own, so this quotes its last
          reply.
        </Text>
      ) : null}
      {!waiting && checkIn.ownerNote ? (
        <View className="gap-1 rounded-2xl bg-subtle p-3">
          <Text className="text-sm font-t3-medium text-foreground">Your Note</Text>
          <ClampedText text={checkIn.ownerNote} lines={4} />
        </View>
      ) : null}
      {waiting ? (
        <View className="flex-row flex-wrap gap-2">
          <ActionButton
            label="Approve"
            accessibilityLabel={`Approve check-in from ${name}`}
            tone="primary"
            disabled={props.working}
            onPress={() => void props.onReview("approve")}
          />
          <ActionButton
            label="Dismiss"
            accessibilityLabel={`Dismiss check-in from ${name}`}
            disabled={props.working}
            onPress={() => void props.onReview("dismiss")}
          />
          <ActionButton
            label="Redirect"
            accessibilityLabel={`Redirect ${name}`}
            disabled={props.working}
            onPress={() => setRedirecting((open) => !open)}
          />
        </View>
      ) : null}
      {canOpen ? (
        <View className="flex-row">
          <ActionButton
            label="Open Conversation"
            accessibilityLabel={`Open conversation with ${name}`}
            onPress={() => agent && props.onOpen(agent)}
          />
        </View>
      ) : null}
      {waiting && redirecting ? (
        <View className="gap-2">
          <View className="overflow-hidden rounded-2xl bg-subtle">
            <FormField
              label="Note For The Agent"
              value={note}
              multiline
              maxLength={AGENT_CHECKIN_NOTE_MAX}
              disabled={props.working}
              onChange={(text) => {
                setNote(text);
                setNoteMissing(false);
              }}
            />
          </View>
          <Text className="px-1 text-sm text-foreground-muted">
            This note is sent to the agent as its next instruction.
          </Text>
          {noteMissing ? (
            <Text accessibilityRole="alert" className="px-1 text-sm text-danger-foreground">
              Write a note first. It is the instruction the agent will follow.
            </Text>
          ) : null}
          <View className="flex-row gap-2">
            <ActionButton
              label="Send Redirect"
              accessibilityLabel={`Send redirect to ${name}`}
              tone="primary"
              disabled={props.working}
              onPress={() => {
                const checked = checkRedirectNote(note);
                setNoteMissing(!checked.ok);
                if (!checked.ok) return;
                void props.onReview("redirect", checked.note).then((sent) => {
                  if (sent) {
                    setRedirecting(false);
                    setNote("");
                  }
                });
              }}
            />
            <ActionButton
              label="Cancel"
              disabled={props.working}
              onPress={() => setRedirecting(false)}
            />
          </View>
        </View>
      ) : null}
      {props.working ? <Text className="text-sm text-foreground-muted">Saving…</Text> : null}
      {props.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : null}
    </View>
  );
}
