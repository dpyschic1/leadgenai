"use client";

import { useState } from "react";
import { MailIcon, MoreHorizontalIcon, RefreshCwIcon, Trash2Icon, UserPlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePermission } from "@/hooks/use-permission";
import { useRemoveMember, useRevokeInvitation, useTeam, useUpdateMemberRole } from "@/hooks/use-team";
import type { PendingInvitation, TeamMember } from "@/lib/api/types";
import { ROLE_LABELS, type AssignableRole } from "@/lib/domain/members";
import { initials } from "@/lib/format";
import { ADMIN_ROLES } from "@/lib/permissions";
import type { InviteMemberInput } from "@/lib/validation/members";
import { InviteMemberDialog } from "./invite-member-dialog";
import { RoleSelect } from "./role-select";
import { SettingsSection } from "./settings-section";

const TITLE = "Team";
const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** Invite state: closed, a fresh invitation, or a new link for an existing one. */
type Inviting = { resend?: InviteMemberInput } | null;

export function TeamSettings() {
  const { data: team } = useTeam();
  const { data: me } = useCurrentUser();
  const canManage = usePermission(ADMIN_ROLES);
  const [inviting, setInviting] = useState<Inviting>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const remove = useRemoveMember();

  return (
    <SettingsSection
      title={TITLE}
      description={
        canManage
          ? "Everyone here works in this workspace with their own sign-in. Roles decide what they can change."
          : "Everyone working in this workspace. Only owners and admins can invite or change roles."
      }
      footer={
        canManage && (
          <Button onClick={() => setInviting({})}>
            <UserPlusIcon />
            Invite teammate
          </Button>
        )
      }
    >
      {!team || !me ? (
        <TeamSkeleton />
      ) : (
        <div className="space-y-6">
          <ul className="-my-3 divide-y" aria-label="Team members">
            {team.members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                isYou={member.userId === me.user.id}
                canManage={canManage}
                onRemove={() => setRemoving(member)}
              />
            ))}
          </ul>

          {team.invitations.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">Invited, not joined yet</h3>
              <ul className="divide-y rounded-lg border" aria-label="Pending invitations">
                {team.invitations.map((invitation) => (
                  <InvitationRow
                    key={invitation.id}
                    invitation={invitation}
                    onNewLink={() =>
                      setInviting({ resend: { email: invitation.email, role: invitation.role as AssignableRole } })
                    }
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <InviteMemberDialog open={inviting !== null} resend={inviting?.resend} onClose={() => setInviting(null)} />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? removing?.email}?`}
        description="They're signed out right away and lose access to this workspace. Everything they added stays."
        confirmLabel="Remove from team"
        pending={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.userId, {
            onSuccess: () => {
              toast.success(`Removed ${removing.name ?? removing.email}.`);
              setRemoving(null);
            },
            onError: (error) => toast.error(error.message),
          })
        }
      />
    </SettingsSection>
  );
}

function MemberRow({
  member,
  isYou,
  canManage,
  onRemove,
}: {
  member: TeamMember;
  isYou: boolean;
  canManage: boolean;
  onRemove: () => void;
}) {
  const updateRole = useUpdateMemberRole();
  // The owner is fixed and nobody changes their own access.
  const manageable = canManage && !isYou && member.role !== "owner";
  const displayName = member.name ?? member.email;

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
        {initials(displayName)}
      </span>
      {/* A minimum width so on phones the role controls wrap below instead of squeezing the name. */}
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-medium">
          {displayName}
          {isYou && <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-xs font-normal text-muted-foreground">You</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {member.email}
          <span aria-hidden> · </span>
          {member.lastLoginAt ? `Last active ${dateFormat.format(new Date(member.lastLoginAt))}` : `Joined ${dateFormat.format(new Date(member.joinedAt))}`}
        </p>
      </div>
      {manageable ? (
        <div className="flex items-center gap-1 pl-13 sm:pl-0">
          <RoleSelect
            value={member.role as AssignableRole}
            aria-label={`Role of ${displayName}`}
            className="h-9! w-36"
            disabled={updateRole.isPending}
            onChange={(role) =>
              updateRole.mutate(
                { userId: member.userId, input: { role } },
                {
                  onSuccess: () => toast.success(`${displayName} is now ${ROLE_LABELS[role].toLowerCase()}.`),
                  onError: (error) => toast.error(error.message),
                },
              )
            }
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`More actions for ${displayName}`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                <Trash2Icon />
                Remove from team
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <span className="ml-13 rounded-full border px-2.5 py-0.5 text-xs font-medium sm:ml-0">{ROLE_LABELS[member.role]}</span>
      )}
    </li>
  );
}

function InvitationRow({ invitation, onNewLink }: { invitation: PendingInvitation; onNewLink: () => void }) {
  const revoke = useRevokeInvitation();

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-muted-foreground">
        <MailIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{invitation.email}</p>
        <p className="text-xs text-muted-foreground">
          {ROLE_LABELS[invitation.role]}
          <span aria-hidden> · </span>
          {invitation.expired ? (
            <span className="text-destructive">Link expired</span>
          ) : (
            `Link works until ${dateFormat.format(new Date(invitation.expiresAt))}`
          )}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={onNewLink}>
          <RefreshCwIcon />
          New link
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          aria-label={`Cancel invitation for ${invitation.email}`}
          title="Cancel invitation"
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(invitation.id, {
              onSuccess: () => toast.success(`Cancelled the invitation for ${invitation.email}.`),
              onError: (error) => toast.error(error.message),
            })
          }
        >
          <XIcon />
        </Button>
      </div>
    </li>
  );
}

function TeamSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading team">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}
