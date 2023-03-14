// Copyright 2021-2023 zcloak authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { BaseCommand, WorkspaceRequiredError } from '@yarnpkg/cli';
import { Cache, Configuration, MessageName, Project, StreamReport } from '@yarnpkg/core';
import { Command, Option, Usage } from 'clipanion';

import * as versionUtils from '../versionUtils';

export default class VersionApplyCommand extends BaseCommand {
  static override paths = [['version', 'apply']];

  static override usage: Usage = Command.Usage({
    category: 'Release-related commands',
    description: 'apply all the deferred version bumps at once',
    details: `
      This command will apply the deferred version changes and remove their definitions from the repository.
      Note that if \`--prerelease\` is set, the given prerelease identifier (by default \`rc.%d\`) will be used on all new versions and the version definitions will be kept as-is.
      By default only the current workspace will be bumped, but you can configure this behavior by using one of:
      - \`--recursive\` to also apply the version bump on its dependencies
      Note that this command will also update the \`workspace:\` references across all your local workspaces, thus ensuring that they keep referring to the same workspaces even after the version bump.
    `,
    examples: [['Apply the version change to the local workspace', 'yarn version apply']]
  });

  dryRun = Option.Boolean('--dry-run', false, {
    description: 'Print the versions without actually generating the package archive'
  });

  prerelease = Option.String('--prerelease', {
    description: 'Add a prerelease identifier to new versions',
    tolerateBoolean: true
  });

  recursive = Option.Boolean('-R,--recursive', {
    description: 'Release the transitive workspaces as well'
  });

  json = Option.Boolean('--json', false, {
    description: 'Format the output as an NDJSON stream'
  });

  async execute() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const { project, workspace } = await Project.find(configuration, this.context.cwd);
    const cache = await Cache.find(configuration);

    if (!workspace) {
      throw new WorkspaceRequiredError(project.cwd, this.context.cwd);
    }

    await project.restoreInstallState({
      restoreResolutions: false
    });

    const applyReport = await StreamReport.start(
      {
        configuration,
        json: this.json,
        stdout: this.context.stdout
      },
      async (report) => {
        const prerelease = this.prerelease ? (typeof this.prerelease !== 'boolean' ? this.prerelease : 'rc.%n') : null;

        const allReleases = await versionUtils.resolveVersionFiles(project, {
          prerelease
        });

        if (allReleases.size === 0) {
          report.reportWarning(MessageName.UNNAMED, "The workspace doesn't seem to require a version bump.");

          return;
        }

        versionUtils.applyReleases(project, allReleases, { report });

        if (!this.dryRun) {
          if (!prerelease) {
            await versionUtils.clearVersionFiles(project);
          }

          report.reportSeparator();

          await project.install({ cache, report });
        }
      }
    );

    return applyReport.exitCode();
  }
}
