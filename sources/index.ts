// Copyright 2021-2023 zcloak authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { Plugin, SettingsType } from '@yarnpkg/core';
import { PortablePath } from '@yarnpkg/fslib';

import VersionApplyCommand from './commands/apply';
import VersionCheckCommand from './commands/check';
import * as versionUtils from './versionUtils';

export { VersionApplyCommand };
export { VersionCheckCommand };
export { versionUtils };

declare module '@yarnpkg/core' {
  interface ConfigurationValueMap {
    deferredVersionFolder: PortablePath;
    preferDeferredVersions: boolean;
  }
}

const plugin: Plugin = {
  configuration: {
    deferredVersionFolder: {
      description: 'Folder where are stored the versioning files',
      type: SettingsType.ABSOLUTE_PATH,
      default: './.yarn/dev-tool-versions'
    },
    preferDeferredVersions: {
      description: 'If true, running `yarn version` will assume the `--deferred` flag unless `--immediate` is set',
      type: SettingsType.BOOLEAN,
      default: false
    }
  },
  commands: [VersionApplyCommand, VersionCheckCommand]
};

export default plugin;
