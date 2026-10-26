// fork: release-build
/**
 * Staged runtime installs have no lockfile, so a range such as `^1.2.0-beta.15`
 * resolves to the newest match, the patch no longer applies, and pnpm fails
 * with ERR_PNPM_UNUSED_PATCH. Returns each staged dependency that has a
 * workspace patch pinned to the version that patch was written for.
 */
export function pinPatchedStageDependencies(
  dependencies: Readonly<Record<string, unknown>>,
  patchedDependencies: Readonly<Record<string, string>>,
): Record<string, string> {
  const pinned: Record<string, string> = {};
  for (const patchKey of Object.keys(patchedDependencies)) {
    const separator = patchKey.lastIndexOf("@");
    if (separator <= 0) continue;
    const name = patchKey.slice(0, separator);
    if (Object.hasOwn(dependencies, name)) pinned[name] = patchKey.slice(separator + 1);
  }
  return pinned;
}
