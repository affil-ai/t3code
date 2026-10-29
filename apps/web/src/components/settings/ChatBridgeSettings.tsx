/**
 * Slack settings for the chat bridge: the app manifest to install, which
 * channel starts threads in which project, who may use it, and the Slack
 * secrets. Secrets are write-only; the server reports only whether each is set.
 */
import {
  AuthSettingsWriteScope,
  type ChatBridgeSlackConfig,
  type ChatBridgeSlackSecretName,
  type ChatBridgeStatus,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { type AtomCommandResult, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useContext, useEffect, useState } from "react";

import { useProjects } from "~/state/entities";
import {
  chatBridgeGetStatus,
  chatBridgeSetSlackSecret,
  chatBridgeUpdateSlackConfig,
} from "~/state/chatBridge";
import { formatEnvironmentQueryError } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const SLACK_ID = /^[A-Z0-9]{2,32}$/;

const CONNECTION_LABEL: Record<ChatBridgeStatus["slack"]["connection"], string> = {
  off: "Off",
  missing_secrets: "Missing secrets",
  starting: "Connecting",
  running: "Connected",
  failed: "Failed",
};

const SECRET_LABEL: Record<ChatBridgeSlackSecretName, { title: string; hint: string }> = {
  botToken: {
    title: "Bot token",
    hint: "xoxb-… from OAuth & Permissions after installing the app.",
  },
  appToken: {
    title: "App-level token",
    hint: "xapp-… with the connections:write scope, from Basic Information.",
  },
  signingSecret: { title: "Signing secret", hint: "From Basic Information → App Credentials." },
};

function parseUserIds(text: string): ReadonlyArray<string> {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((id) => id.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export function ChatBridgeSettings() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  return (
    <SettingsSection id="chat-bridge" title="Slack">
      {environmentId ? (
        <ChatBridgeSlackControls key={environmentId} environmentId={environmentId} />
      ) : (
        <SettingsRow title="Slack" description="Connect to an environment to set up Slack." />
      )}
    </SettingsSection>
  );
}

function ChatBridgeSlackControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canConfigure = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && !project.isScratch,
  );
  const updateConfig = useAtomCommand(chatBridgeUpdateSlackConfig, { reportFailure: false });
  const setSecret = useAtomCommand(chatBridgeSetSlackSecret, { reportFailure: false });

  const [status, setStatus] = useState<ChatBridgeStatus["slack"] | null>(null);
  const [draft, setDraft] = useState<ChatBridgeSlackConfig | null>(null);
  const [allowlistText, setAllowlistText] = useState("");
  const [secretDrafts, setSecretDrafts] = useState<
    Partial<Record<ChatBridgeSlackSecretName, string>>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const accept = (next: ChatBridgeStatus) => {
    setStatus(next.slack);
    setDraft(next.slack.config);
    setAllowlistText(next.slack.config.allowedUserIds.join("\n"));
  };

  // Load once per environment; later updates come back from each save.
  const registry = useContext(RegistryContext);
  useEffect(() => {
    if (!canConfigure) return;
    let cancelled = false;
    void runAtomCommand(
      registry,
      chatBridgeGetStatus,
      { environmentId, input: {} },
      { label: chatBridgeGetStatus.label, reportFailure: false, reportDefect: true },
    ).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setStatus(result.value.slack);
        setDraft(result.value.slack.config);
        setAllowlistText(result.value.slack.config.allowedUserIds.join("\n"));
      } else {
        setError(formatEnvironmentQueryError(result.cause));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [registry, environmentId, canConfigure]);

  if (!canConfigure) {
    return (
      <SettingsRow title="Slack" description="This connection cannot change Slack settings." />
    );
  }
  if (status === null || draft === null) {
    return <SettingsRow title="Slack" description={error ?? "Loading…"} />;
  }

  const run = async <E,>(action: () => Promise<AtomCommandResult<ChatBridgeStatus, E>>) => {
    setPending(true);
    setError(null);
    const result = await action();
    setPending(false);
    if (result._tag === "Success") accept(result.value);
    else setError(formatEnvironmentQueryError(result.cause));
  };

  const allowedUserIds = parseUserIds(allowlistText);
  const invalidUsers = allowedUserIds.filter((id) => !SLACK_ID.test(id));
  const invalidChannels = draft.channelProjects.filter((entry) => !SLACK_ID.test(entry.channelId));
  const canSave = invalidUsers.length === 0 && invalidChannels.length === 0 && !pending;
  const save = (config: ChatBridgeSlackConfig) =>
    run(() => updateConfig({ environmentId, input: config }));

  const secretNames: ReadonlyArray<ChatBridgeSlackSecretName> =
    draft.transport === "socket" ? ["botToken", "appToken"] : ["botToken", "signingSecret"];

  return (
    <>
      <SettingsRow
        title="Slack bridge"
        description="Mention the bot in a mapped channel to start a thread in its project. Replies in that Slack thread queue on the same T3 thread, and each run's final answer is posted back."
        status={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status.connection === "running" ? "success" : "outline"}>
              {CONNECTION_LABEL[status.connection]}
            </Badge>
            {status.error ? <span className="text-xs text-destructive">{status.error}</span> : null}
            {error ? (
              <span role="alert" className="text-xs text-destructive">
                {error}
              </span>
            ) : null}
          </div>
        }
        control={
          <Switch
            aria-label="Slack bridge"
            checked={status.config.enabled}
            disabled={pending || !canSave}
            onCheckedChange={(checked) =>
              void save({ ...draft, allowedUserIds, enabled: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        title="Connection"
        description="Socket Mode needs no public URL and suits a server behind NAT. Events API delivery goes through this environment's T3 Connect hook URL."
        control={
          <Select
            value={draft.transport}
            onValueChange={(value) => {
              if (value === "socket" || value === "webhook")
                setDraft({ ...draft, transport: value });
            }}
          >
            <SelectTrigger aria-label="Slack connection" className="min-w-40" size="xs">
              <SelectValue>
                {draft.transport === "socket" ? "Socket Mode" : "Events API (T3 Connect)"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="socket">Socket Mode</SelectItem>
              <SelectItem value="webhook">Events API (T3 Connect)</SelectItem>
            </SelectPopup>
          </Select>
        }
      >
        {draft.transport === "webhook" ? (
          <p className="text-xs text-muted-foreground">
            {status.webhookUrl
              ? "The manifest below carries this environment's hook URL."
              : "Turn on T3 Connect remote access to get a hook URL for Slack."}
          </p>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Replies while a run is going"
        description="Steer adds a Slack reply to the run in flight, and that run's answer covers both. Queue runs it after the current run ends."
        control={
          <Select
            value={draft.followUpMode ?? "steer"}
            onValueChange={(value) => {
              if (value === "steer" || value === "queue")
                setDraft({ ...draft, followUpMode: value });
            }}
          >
            <SelectTrigger aria-label="Slack follow-ups" className="min-w-40" size="xs">
              <SelectValue>
                {(draft.followUpMode ?? "steer") === "steer" ? "Steer" : "Queue"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="steer">Steer</SelectItem>
              <SelectItem value="queue">Queue</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Slack app manifest"
        description="Create the app at api.slack.com/apps → From a manifest, then install it to your workspace. Save the connection choice first so the manifest matches it."
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(status.manifest)}
          >
            Copy
          </Button>
        }
      >
        <Textarea readOnly rows={6} value={status.manifest} />
      </SettingsRow>
      {secretNames.map((name) => (
        <SettingsRow
          key={name}
          title={SECRET_LABEL[name].title}
          description={SECRET_LABEL[name].hint}
          status={
            <Badge variant={status.secrets[name] ? "success" : "outline"}>
              {status.secrets[name] ? "Saved" : "Not set"}
            </Badge>
          }
          control={
            <div className="flex items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                aria-label={SECRET_LABEL[name].title}
                className="w-56"
                value={secretDrafts[name] ?? ""}
                onChange={(event) =>
                  setSecretDrafts({ ...secretDrafts, [name]: event.target.value })
                }
              />
              <Button
                size="sm"
                disabled={pending || !(secretDrafts[name] ?? "").trim()}
                onClick={() =>
                  void run(() =>
                    setSecret({
                      environmentId,
                      input: { name, value: (secretDrafts[name] ?? "").trim() },
                    }),
                  ).then(() => setSecretDrafts({ ...secretDrafts, [name]: "" }))
                }
              >
                Save
              </Button>
              {status.secrets[name] ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    void run(() => setSecret({ environmentId, input: { name, value: null } }))
                  }
                >
                  Clear
                </Button>
              ) : null}
            </div>
          }
        />
      ))}
      <SettingsRow
        title="Channels"
        description="Invite the bot to each channel. A mention in a channel that is not listed is ignored."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={projects.length === 0}
            onClick={() =>
              setDraft({
                ...draft,
                channelProjects: [
                  ...draft.channelProjects,
                  { channelId: "", projectId: projects[0]!.id },
                ],
              })
            }
          >
            Add channel
          </Button>
        }
      >
        <div className="space-y-2">
          {draft.channelProjects.map((entry, index) => {
            const replace = (next: Partial<(typeof draft.channelProjects)[number]>) =>
              setDraft({
                ...draft,
                channelProjects: draft.channelProjects.map((each, at) =>
                  at === index ? { ...each, ...next } : each,
                ),
              });
            return (
              <div key={index} className="flex items-center gap-2">
                <Input
                  aria-label="Slack channel ID"
                  placeholder="C0123ABCD"
                  className="w-40"
                  value={entry.channelId}
                  onChange={(event) =>
                    replace({ channelId: event.target.value.trim().toUpperCase() })
                  }
                />
                <Select
                  value={entry.projectId}
                  onValueChange={(value) => {
                    if (value !== null) replace({ projectId: value as ProjectId });
                  }}
                >
                  <SelectTrigger aria-label="Project" className="min-w-48" size="xs">
                    <SelectValue>
                      {projects.find((project) => project.id === entry.projectId)?.title ??
                        "Missing project"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDraft({
                      ...draft,
                      channelProjects: draft.channelProjects.filter((_, at) => at !== index),
                    })
                  }
                >
                  Remove
                </Button>
              </div>
            );
          })}
          {invalidChannels.length > 0 ? (
            <p className="text-xs text-destructive">Channel IDs look like C0123ABCD.</p>
          ) : null}
        </div>
      </SettingsRow>
      <SettingsRow
        title="Allowed people"
        description="Slack member IDs (Profile → ⋯ → Copy member ID), one per line. Messages from anyone else are ignored. Runs use this server's default runtime mode, so list only people you would let use T3 Code directly."
      >
        <Textarea
          aria-label="Allowed Slack member IDs"
          rows={3}

          placeholder="U0123ABCD"
          value={allowlistText}
          onChange={(event) => setAllowlistText(event.target.value)}
        />
        {invalidUsers.length > 0 ? (
          <p className="text-xs text-destructive">Not a member ID: {invalidUsers.join(", ")}</p>
        ) : null}
      </SettingsRow>
      <div className="flex justify-end">
        <Button disabled={!canSave} onClick={() => void save({ ...draft, allowedUserIds })}>
          {pending ? "Saving…" : "Save Slack settings"}
        </Button>
      </div>
    </>
  );
}
