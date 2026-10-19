/** Keep environment grouping intact; coordinator homes and Scratch are not user repositories. */
export function workRepositories<
  T extends {
    isScratch?: boolean;
    memberProjects: readonly { physicalProjectKey: string }[];
  },
>(
  projects: readonly T[],
  coordinatorProjectKeys: ReadonlySet<string>,
  memberKey: (member: T["memberProjects"][number]) => string = (member) =>
    member.physicalProjectKey,
): T[] {
  return projects.filter(
    (project) =>
      !project.isScratch &&
      project.memberProjects.some((member) => !coordinatorProjectKeys.has(memberKey(member))),
  );
}
