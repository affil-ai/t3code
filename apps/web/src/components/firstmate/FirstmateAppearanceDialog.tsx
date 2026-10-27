/**
 * Renames Firstmate and picks its icon. Both are stored on the server, so
 * every client sees them, and the coordinator chat takes the new name.
 */
import {
  AGENT_DEFAULT_COLOR,
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useId, useState } from "react";

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
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useAgentCommands } from "../agents/agentCommands";
import { AgentAvatar } from "../agents/AgentAvatar";
import { AgentAvatarUpload } from "../agents/AgentAvatarUpload";
import {
  FIRSTMATE_ICON_KEYS,
  type FirstmateIconKey,
  resolveFirstmateIconKey,
} from "@t3tools/client-runtime/firstmate/icons";
import { FIRSTMATE_ICONS } from "./firstmateIcons";

const NAME_MAX_LENGTH = 60;

export function FirstmateAppearanceDialog({
  environmentId,
  name,
  icon,
  open,
  onOpenChange,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly icon: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly agent?: AgentProfile | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AppearanceForm
          environmentId={environmentId}
          initialName={name}
          initialIcon={resolveFirstmateIconKey(icon)}
          agent={agent}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Dialog>
  );
}

function AppearanceForm({
  environmentId,
  initialName,
  initialIcon,
  onDone,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialName: string;
  readonly initialIcon: FirstmateIconKey;
  readonly onDone: () => void;
  readonly agent?: AgentProfile | undefined;
}) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<FirstmateIconKey>(initialIcon);
  const [avatarAttachmentId, setAvatarAttachmentId] = useState(agent?.avatarAttachmentId ?? null);
  const [uploading, setUploading] = useState(false);
  const { pending, update, run } = useAgentCommands();
  const trimmed = name.trim();
  const unchanged =
    trimmed === initialName &&
    icon === initialIcon &&
    avatarAttachmentId === (agent?.avatarAttachmentId ?? null);
  return (
    <DialogPopup className="sm:max-w-sm">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length === 0 || pending !== null || uploading) return;
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
                  agentId: FIRSTMATE_AGENT_ID,
                  name: trimmed,
                  icon,
                  ...(avatarAttachmentId === (agent?.avatarAttachmentId ?? null)
                    ? {}
                    : { avatarAttachmentId }),
                },
              }),
            "Could not save the name and icon",
          ).then((snapshot) => {
            if (snapshot !== null) onDone();
          });
        }}
      >
        <DialogHeader>
          <DialogTitle>Name and icon</DialogTitle>
          <DialogDescription>
            Shown in the sidebar and the Tasks panel. The chat is renamed too.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <AgentAvatar
                icon={icon}
                color={agent?.color ?? AGENT_DEFAULT_COLOR}
                environmentId={environmentId}
                avatarAttachmentId={avatarAttachmentId ?? undefined}
              />
              <AgentAvatarUpload
                environmentId={environmentId}
                value={avatarAttachmentId}
                disabled={pending !== null}
                onChange={setAvatarAttachmentId}
                onPendingChange={setUploading}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                value={name}
                maxLength={NAME_MAX_LENGTH}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setName(event.currentTarget.value)}
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
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={trimmed.length === 0 || pending !== null || uploading}>
            {pending === "update" ? <Spinner className="size-3.5" /> : null}
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
