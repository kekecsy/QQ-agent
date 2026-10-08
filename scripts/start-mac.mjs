import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.QQ_AGENT_DATA_DIR || path.resolve(root, '../qq-agent-config/data');
// LaunchServices gives Electron its own macOS permission identity.
execFileSync('/usr/bin/open', [
  '-n', '-a', path.join(root, 'node_modules/electron/dist/Electron.app'),
  '--env', `QQ_AGENT_DATA_DIR=${dataDir}`,
  '--env', 'ELECTRON_RUN_AS_NODE',
  '--args', root
], { stdio: 'inherit' });
