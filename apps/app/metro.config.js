const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')
const { createRequire } = require('module')

const projectRoot = __dirname
const workspaceRoot = path.resolve(projectRoot, '../..')
const appRequire = createRequire(path.join(projectRoot, 'package.json'))

const config = getDefaultConfig(projectRoot)

// Monorepo: watch shared packages, but resolve app dependencies first so the
// root's web React version cannot override the native app's React runtime.
config.watchFolders = [workspaceRoot]
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// Allow nested package deps (e.g. react-native → scheduler) on EAS,
// where monorepo hoisting differs from local installs.
config.resolver.disableHierarchicalLookup = false

// TypeScript maps `react` to the app-local React types; Metro must bundle the
// matching app-local runtime package.
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === 'react' ||
    moduleName === 'react/jsx-runtime' ||
    moduleName === 'react/jsx-dev-runtime'
  ) {
    return {
      filePath: appRequire.resolve(moduleName),
      type: 'sourceFile',
    }
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform)
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
