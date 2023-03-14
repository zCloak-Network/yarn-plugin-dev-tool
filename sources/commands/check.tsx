// Copyright 2021-2023 zcloak authors & contributors
// SPDX-License-Identifier: Apache-2.0

/* eslint-disable no-lone-blocks */

import type { FocusRequest } from '@yarnpkg/libui/sources/hooks/useFocusRequest';

import { BaseCommand, WorkspaceRequiredError } from '@yarnpkg/cli';
import { Configuration, Project, structUtils, Workspace } from '@yarnpkg/core';
import { npath } from '@yarnpkg/fslib';
import * as libuiUtils from '@yarnpkg/libui/sources/libuiUtils';
import { Command, Usage, UsageError } from 'clipanion';
import semver from 'semver';

import * as versionUtils from '../versionUtils';

export default class VersionCheckCommand extends BaseCommand {
  static override paths = [['version', 'check']];

  static override usage: Usage = Command.Usage({
    category: 'Release-related commands',
    description: 'check that all the relevant packages have been bumped',
    details: `
      **Warning:** This command currently requires Git.
      This command will check that all the packages covered by the files listed in argument have been properly bumped or declined to bump.
      In the case of a bump, the check will also cover transitive packages - meaning that should \`Foo\` be bumped, a package \`Bar\` depending on \`Foo\` will require a decision as to whether \`Bar\` will need to be bumped. This check doesn't cross packages that have declined to bump.
      In case no arguments are passed to the function, the list of modified files will be generated by comparing the HEAD against \`master\`.
    `,
    examples: [['Check whether the modified packages need a bump', 'yarn version check']]
  });

  async execute() {
    return await this.executeInteractive();
  }

  async executeInteractive() {
    libuiUtils.checkRequirements(this.context);

    const { Gem } = await import('@yarnpkg/libui/sources/components/Gem');
    const { ScrollableItems } = await import('@yarnpkg/libui/sources/components/ScrollableItems');
    const { FocusRequest } = await import('@yarnpkg/libui/sources/hooks/useFocusRequest');
    const { useListInput } = await import('@yarnpkg/libui/sources/hooks/useListInput');
    const { renderForm } = await import('@yarnpkg/libui/sources/misc/renderForm');
    const { Box, Text } = await import('ink');
    const { default: React, useCallback, useState } = await import('react');

    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const { project, workspace } = await Project.find(configuration, this.context.cwd);

    if (!workspace) {
      throw new WorkspaceRequiredError(project.cwd, this.context.cwd);
    }

    await project.restoreInstallState();

    const versionFile = await versionUtils.openVersionFile(project);

    if (versionFile === null || versionFile.releaseRoots.size === 0) {
      return 0;
    }

    if (versionFile.root === null) {
      throw new UsageError('This command can only be run on Git repositories');
    }

    const Prompt = () => {
      return (
        <Box flexDirection={'row'} paddingBottom={1}>
          <Box flexDirection={'column'} width={60}>
            <Box>
              <Text>
                Press{' '}
                <Text bold color={'cyanBright'}>
                  {'<up>'}
                </Text>
                /
                <Text bold color={'cyanBright'}>
                  {'<down>'}
                </Text>{' '}
                to select workspaces.
              </Text>
            </Box>
            <Box>
              <Text>
                Press{' '}
                <Text bold color={'cyanBright'}>
                  {'<left>'}
                </Text>
                /
                <Text bold color={'cyanBright'}>
                  {'<right>'}
                </Text>{' '}
                to select release strategies.
              </Text>
            </Box>
          </Box>
          <Box flexDirection={'column'}>
            <Box marginLeft={1}>
              <Text>
                Press{' '}
                <Text bold color={'cyanBright'}>
                  {'<enter>'}
                </Text>{' '}
                to save.
              </Text>
            </Box>
            <Box marginLeft={1}>
              <Text>
                Press{' '}
                <Text bold color={'cyanBright'}>
                  {'<ctrl+c>'}
                </Text>{' '}
                to abort.
              </Text>
            </Box>
          </Box>
        </Box>
      );
    };

    const Undecided = ({
      active,
      decision,
      setDecision,
      workspace
    }: {
      workspace: Workspace;
      active?: boolean;
      decision: string;
      setDecision: (decision: versionUtils.Decision) => void;
    }) => {
      const currentVersion = workspace.manifest.raw.stableVersion ?? workspace.manifest.version;

      if (currentVersion === null) {
        throw new Error(
          `Assertion failed: The version should have been set (${structUtils.prettyLocator(
            configuration,
            workspace.anchoredLocator
          )})`
        );
      }

      if (semver.prerelease(currentVersion) !== null) {
        throw new Error(`Assertion failed: Prerelease identifiers shouldn't be found (${currentVersion})`);
      }

      const strategies: Array<versionUtils.Decision> = [
        versionUtils.Decision.UNDECIDED,
        versionUtils.Decision.DECLINE,
        versionUtils.Decision.PATCH,
        versionUtils.Decision.MINOR,
        versionUtils.Decision.MAJOR
      ];

      useListInput(decision, strategies, {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        active: active!,
        minus: 'left',
        plus: 'right',
        set: setDecision
      });

      const nextVersion =
        decision === versionUtils.Decision.UNDECIDED ? (
          <Text color={'yellow'}>{currentVersion}</Text>
        ) : decision === versionUtils.Decision.DECLINE ? (
          <Text color={'green'}>{currentVersion}</Text>
        ) : (
          <Text>
            <Text color={'magenta'}>{currentVersion}</Text> →{' '}
            <Text color={'green'}>
              {semver.valid(decision)
                ? decision
                : semver.inc(currentVersion, decision as versionUtils.IncrementDecision)}
            </Text>
          </Text>
        );

      return (
        <Box flexDirection={'column'}>
          <Box>
            <Text>
              {structUtils.prettyLocator(configuration, workspace.anchoredLocator)} - {nextVersion}
            </Text>
          </Box>
          <Box>
            {strategies.map((strategy) => {
              const isGemActive = strategy === decision;

              return (
                <Box key={strategy} paddingLeft={2}>
                  <Text>
                    <Gem active={isGemActive} /> {strategy}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      );
    };

    const getRelevancy = (releases: versionUtils.Releases) => {
      // Now, starting from all the workspaces that changed, we'll detect
      // which ones are affected by the choices that the user picked. By
      // doing this we'll "forget" all choices that aren't relevant any
      // longer (for example, imagine that the user decided to re-release
      // something, then its dependents, but then decided to not release
      // the original package anymore; then the dependents don't need to
      // released anymore)

      const relevantWorkspaces = new Set(versionFile.releaseRoots);
      const relevantReleases = new Map(
        [...releases].filter(([workspace]) => {
          return relevantWorkspaces.has(workspace);
        })
      );

      while (true) {
        const undecidedDependentWorkspaces = versionUtils.getUndecidedDependentWorkspaces({
          project: versionFile.project,
          releases: relevantReleases
        });

        let hasNewDependents = false;

        if (undecidedDependentWorkspaces.length > 0) {
          for (const [workspace] of undecidedDependentWorkspaces) {
            if (!relevantWorkspaces.has(workspace)) {
              relevantWorkspaces.add(workspace);
              hasNewDependents = true;

              const release = releases.get(workspace);

              if (typeof release !== 'undefined') {
                relevantReleases.set(workspace, release);
              }
            }
          }
        }

        if (!hasNewDependents) {
          break;
        }
      }

      return {
        relevantWorkspaces,
        relevantReleases
      };
    };

    const useReleases = (): [
      versionUtils.Releases,
      (workspace: Workspace, decision: versionUtils.Decision) => void
    ] => {
      const [releases, setReleases] = useState<versionUtils.Releases>(() => new Map(versionFile.releases));

      const setWorkspaceRelease = useCallback(
        (workspace: Workspace, decision: versionUtils.Decision) => {
          const copy = new Map(releases);

          if (decision !== versionUtils.Decision.UNDECIDED) {
            copy.set(workspace, decision);
          } else {
            copy.delete(workspace);
          }

          const { relevantReleases } = getRelevancy(copy);

          setReleases(relevantReleases);
        },
        [releases, setReleases]
      );

      return [releases, setWorkspaceRelease];
    };

    const Stats = ({ releases, workspaces }: { workspaces: Set<Workspace>; releases: versionUtils.Releases }) => {
      const parts = [];

      parts.push(`${workspaces.size} total`);

      let releaseCount = 0;
      let remainingCount = 0;

      for (const workspace of workspaces) {
        const release = releases.get(workspace);

        if (typeof release === 'undefined') {
          remainingCount += 1;
        } else if (release !== versionUtils.Decision.DECLINE) {
          releaseCount += 1;
        }
      }

      parts.push(`${releaseCount} release${releaseCount === 1 ? '' : 's'}`);
      parts.push(`${remainingCount} remaining`);

      return <Text color={'yellow'}>{parts.join(', ')}</Text>;
    };

    const App = ({ useSubmit }: { useSubmit: (value: versionUtils.Releases) => void }) => {
      const [releases, setWorkspaceRelease] = useReleases();

      useSubmit(releases);

      const { relevantWorkspaces } = getRelevancy(releases);
      const dependentWorkspaces = new Set(
        [...relevantWorkspaces].filter((workspace) => {
          return !versionFile.releaseRoots.has(workspace);
        })
      );

      const [focus, setFocus] = useState(0);

      const handleFocusRequest = useCallback(
        (request: FocusRequest) => {
          switch (request) {
            case FocusRequest.BEFORE:
              {
                setFocus(focus - 1);
              }

              break;
            case FocusRequest.AFTER:
              {
                setFocus(focus + 1);
              }

              break;
          }
        },
        [focus, setFocus]
      );

      return (
        <Box flexDirection={'column'}>
          <Prompt />
          <Box>
            <Text wrap={'wrap'}>The following files have been modified in your local checkout.</Text>
          </Box>
          <Box flexDirection={'column'} marginTop={1} paddingLeft={2}>
            {[...versionFile.changedFiles].map((file) => (
              <Box key={file}>
                <Text>
                  <Text color={'grey'}>{npath.fromPortablePath(versionFile.root)}</Text>
                  {npath.sep}
                  {npath.relative(npath.fromPortablePath(versionFile.root), npath.fromPortablePath(file))}
                </Text>
              </Box>
            ))}
          </Box>
          {versionFile.releaseRoots.size > 0 && (
            <>
              <Box marginTop={1}>
                <Text wrap={'wrap'}>
                  Because of those files having been modified, the following workspaces may need to be released again
                  (note that private workspaces are also shown here, because even though they wont be published,
                  releasing them will allow us to flag their dependents for potential re-release):
                </Text>
              </Box>
              {dependentWorkspaces.size > 3 ? (
                <Box marginTop={1}>
                  <Stats releases={releases} workspaces={versionFile.releaseRoots} />
                </Box>
              ) : null}
              <Box flexDirection={'column'} marginTop={1}>
                <ScrollableItems active={focus % 2 === 0} onFocusRequest={handleFocusRequest} radius={1} size={2}>
                  {[...versionFile.releaseRoots].map((workspace) => (
                    <Undecided
                      decision={releases.get(workspace) || versionUtils.Decision.UNDECIDED}
                      key={workspace.cwd}
                      setDecision={(decision) => setWorkspaceRelease(workspace, decision)}
                      workspace={workspace}
                    />
                  ))}
                </ScrollableItems>
              </Box>
            </>
          )}
          {dependentWorkspaces.size > 0 ? (
            <>
              <Box marginTop={1}>
                <Text wrap={'wrap'}>
                  The following workspaces depend on other workspaces that have been marked for release, and thus may
                  need to be released as well:
                </Text>
              </Box>
              <Box>
                <Text>
                  (Press{' '}
                  <Text bold color={'cyanBright'}>
                    {'<tab>'}
                  </Text>{' '}
                  to move the focus between the workspace groups.)
                </Text>
              </Box>
              {dependentWorkspaces.size > 5 ? (
                <Box marginTop={1}>
                  <Stats releases={releases} workspaces={dependentWorkspaces} />
                </Box>
              ) : null}
              <Box flexDirection={'column'} marginTop={1}>
                <ScrollableItems active={focus % 2 === 1} onFocusRequest={handleFocusRequest} radius={2} size={2}>
                  {[...dependentWorkspaces].map((workspace) => (
                    <Undecided
                      decision={releases.get(workspace) || versionUtils.Decision.UNDECIDED}
                      key={workspace.cwd}
                      setDecision={(decision) => setWorkspaceRelease(workspace, decision)}
                      workspace={workspace}
                    />
                  ))}
                </ScrollableItems>
              </Box>
            </>
          ) : null}
        </Box>
      );
    };

    const decisions = await renderForm<versionUtils.Releases>(
      App,
      { versionFile },
      {
        stdin: this.context.stdin,
        stdout: this.context.stdout,
        stderr: this.context.stderr
      }
    );

    if (typeof decisions === 'undefined') {
      return 1;
    }

    versionFile.releases.clear();

    for (const [workspace, decision] of decisions) {
      versionFile.releases.set(workspace, decision);
    }

    await versionFile.saveAll();

    return undefined;
  }
}
