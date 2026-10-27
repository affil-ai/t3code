/**
 * Creates an agent, or edits one's name, role, icon, and color. Creating seeds
 * the agent's folder in the shared repository and starts its chat with the
 * model a fresh Scratch chat would use.
 */
import type { AgentProfile, EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import { AGENT_DEFAULT_COLOR } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { cn } from "~/lib/utils";
import { PROJECT_ICON_COLORS } from "~/projectIconColors";
import { useFirstmateModelSelection } from "../firstmate/firstmateModel";
import {
  FIRSTMATE_ICON_KEYS,
  type FirstmateIconKey,
  resolveFirstmateIconKey,
} from "@t3tools/client-runtime/firstmate/icons";
import { FIRSTMATE_ICONS } from "../firstmate/firstmateIcons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AgentAvatar } from "./AgentAvatar";
import { AgentAvatarUpload } from "./AgentAvatarUpload";
import { useSelectedAgentStore } from "~/selectedAgentStore";
import { useAgentCommands } from "./agentCommands";
import { useSidebar } from "../ui/sidebar";

const NAME_MAX_LENGTH = 60;
const ROLE_MAX_LENGTH = 2000;

export function AgentDialog({
  environmentId,
  agent,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  /** The agent to edit, or null to create one. */
  readonly agent: AgentProfile | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AgentForm environmentId={environmentId} agent={agent} onDone={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  );
}

function AgentForm({
  environmentId,
  agent,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile | null;
  readonly onDone: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [icon, setIcon] = useState<FirstmateIconKey>(resolveFirstmateIconKey(agent?.icon ?? "bot"));
  const [color, setColor] = useState<ProjectIconColor>(agent?.color ?? AGENT_DEFAULT_COLOR);
  const [avatarAttachmentId, setAvatarAttachmentId] = useState(agent?.avatarAttachmentId ?? null);
  const [uploading, setUploading] = useState(false);
  const modelSelection = useFirstmateModelSelection(environmentId);
  const { pending, create, update, run } = useAgentCommands();
  const trimmedName = name.trim();
  const trimmedRole = role.trim();
  const valid = trimmedName.length > 0 && trimmedRole.length > 0;
  const creating = agent === null;
  const unchanged =
    agent !== null &&
    trimmedName === agent.name &&
    trimmedRole === agent.role &&
    icon === resolveFirstmateIconKey(agent.icon) &&
    color === agent.color &&
    avatarAttachmentId === (agent.avatarAttachmentId ?? null);

  const submit = () => {
    if (!valid || pending !== null || uploading) return;
    if (creating) {
      if (modelSelection === null) return;
      void run(
        "create",
        () =>
          create({
            environmentId,
            input: {
              name: trimmedName,
              role: trimmedRole,
              icon,
              color,
              modelSelection,
              ...(avatarAttachmentId === null ? {} : { avatarAttachmentId }),
            },
          }),
        "Could not create the agent",
      ).then((created) => {
        if (created === null) return;
        // The sidebar follows the agent that was just made.
        useSelectedAgentStore.getState().selectAgent(created.agent.id);
        onDone();
        if (isMobile) setOpenMobile(false);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: created.threadId },
        });
      });
      return;
    }
    if (unchanged) {
      onDone();
      return;
    }
    void run(
      "update",
      () =>
        update({
          environmentId,
          input: {
            agentId: agent.id,
            ...(trimmedName === agent.name ? {} : { name: trimmedName }),
            ...(trimmedRole === agent.role ? {} : { role: trimmedRole }),
            ...(icon === agent.icon ? {} : { icon }),
            ...(color === agent.color ? {} : { color }),
            ...(avatarAttachmentId === (agent.avatarAttachmentId ?? null)
              ? {}
              : { avatarAttachmentId }),
          },
        }),
      "Could not save the agent",
    ).then((updated) => {
      if (updated !== null) onDone();
    });
  };

  return (
    <DialogPopup className="sm:max-w-md">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <DialogHeader>
          <DialogTitle>{creating ? "New agent" : "Edit agent"}</DialogTitle>
          <DialogDescription>
            {creating
              ? "An agent is a chat with its own task board. Its role becomes the top of its instructions."
              : "The role is rewritten at the top of the agent's instructions. The chat is renamed too."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <AgentAvatar
                icon={icon}
                color={color}
                environmentId={environmentId}
                avatarAttachmentId={avatarAttachmentId ?? undefined}
                className="size-12 rounded-2xl"
                iconClassName="size-6"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={NAME_MAX_LENGTH}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Growth Lead"
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </div>
            </div>
            <AgentAvatarUpload
              environmentId={environmentId}
              value={avatarAttachmentId}
              disabled={pending !== null}
              onChange={setAvatarAttachmentId}
              onPendingChange={setUploading}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-role`}>Role</Label>
              <Textarea
                id={`${id}-role`}
                value={role}
                maxLength={ROLE_MAX_LENGTH}
                rows={3}
                placeholder="You run growth: affiliate partnerships, outreach, and reporting. You keep the user's calendar of partner follow-ups."
                onChange={(event) => setRole(event.currentTarget.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label id={`${id}-icon`}>Icon</Label>
              <ToggleGroup
                aria-labelledby={`${id}-icon`}
                variant="outline"
                className="grid w-full grid-cols-6"
                value={[icon]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value !== undefined) setIcon(resolveFirstmateIconKey(value));
                }}
              >
                {FIRSTMATE_ICON_KEYS.map((key) => {
                  const { label, Icon } = FIRSTMATE_ICONS[key];
                  return (
                    <Toggle key={key} value={key} aria-label={label} title={label}>
                      <Icon />
                    </Toggle>
                  );
                })}
              </ToggleGroup>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label id={`${id}-color`}>Color</Label>
              <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${id}-color`}>
                {PROJECT_ICON_COLORS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-label={option.label}
                    aria-pressed={color === option.value}
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      color === option.value && "border-foreground/64",
                    )}
                    onClick={() => setColor(option.value)}
                  >
                    <span className={cn("size-4 rounded-full", option.swatchClassName)} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              !valid || pending !== null || uploading || (creating && modelSelection === null)
            }
          >
            {pending !== null ? <Spinner className="size-3.5" /> : null}
            {creating ? "Create and start" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
