/**
 * Renames Firstmate and picks its icon. Both are stored on the server, so
 * every client sees them, and the coordinator chat takes the new name.
 */
import type { EnvironmentId } from "@t3tools/contracts";
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
import { useFirstmateCommands } from "./firstmateCommands";
import {
  FIRSTMATE_ICON_KEYS,
  FIRSTMATE_ICONS,
  type FirstmateIconKey,
  resolveFirstmateIconKey,
} from "./firstmateIcons";

const NAME_MAX_LENGTH = 60;

export function FirstmateAppearanceDialog({
  environmentId,
  name,
  icon,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly icon: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AppearanceForm
          environmentId={environmentId}
          initialName={name}
          initialIcon={resolveFirstmateIconKey(icon)}
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
}: {
  readonly environmentId: EnvironmentId;
  readonly initialName: string;
  readonly initialIcon: FirstmateIconKey;
  readonly onDone: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState<FirstmateIconKey>(initialIcon);
  const { pending, setAppearance, run } = useFirstmateCommands();
  const trimmed = name.trim();
  const unchanged = trimmed === initialName && icon === initialIcon;
  return (
    <DialogPopup className="sm:max-w-sm">
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed.length === 0 || pending !== null) return;
          if (unchanged) {
            onDone();
            return;
          }
          void run(
            "setAppearance",
            () => setAppearance({ environmentId, input: { name: trimmed, icon } }),
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
          <Button type="submit" disabled={trimmed.length === 0 || pending !== null}>
            {pending === "setAppearance" ? <Spinner className="size-3.5" /> : null}
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}
