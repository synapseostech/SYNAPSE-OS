#!/usr/bin/env node
/**
 * Align Vercel dashboard project settings with repo vercel.json (source of truth).
 * Requires: logged in via `vercel login` OR VERCEL_TOKEN env.
 *
 * Usage: node scripts/sync-vercel-projects.mjs
 */
import { spawnSync } from 'node:child_process'

const TEAM_ID = 'team_IfLX69fKbBxupsNAtDVzF573'

const PROJECTS = [
  {
    name: 'synapse-demo',
    id: 'prj_pMAegOucrRxzMOdNgjNYCXE8G7aM',
    rootDirectory: null,
    buildCommand:
      'node scripts/sync-web-public.mjs && npm run build --workspace @synapse/web',
    outputDirectory: 'apps/web/.next',
    installCommand: 'npm install',
    nodeVersion: '22.x',
  },
  {
    name: 'synapse-pharm',
    id: 'prj_CHbxKSy0pee2nieRVvQ3Rhyw4cnh',
    rootDirectory: 'apps/pharmacy',
    buildCommand:
      'cd ../.. && NODE_OPTIONS=--max-old-space-size=4096 npm run build --workspace @synapse/pharmacy',
    outputDirectory: '.next',
    installCommand: 'cd ../.. && npm install',
    ignoreCommand: 'node ../../scripts/vercel-build-gate.mjs pharmacy',
    nodeVersion: '22.x',
  },
]

function getToken() {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN
  console.error(
    'Set VERCEL_TOKEN (create at https://vercel.com/account/tokens).\n' +
      'CLI session auth cannot PATCH project settings via REST API.'
  )
  process.exit(1)
}

async function patchProject(project, token) {
  const url = `https://api.vercel.com/v9/projects/${project.id}?teamId=${TEAM_ID}`
  const body = {
    buildCommand: project.buildCommand,
    outputDirectory: project.outputDirectory,
    installCommand: project.installCommand,
    nodeVersion: project.nodeVersion,
    framework: 'nextjs',
  }
  if (project.rootDirectory) {
    body.rootDirectory = project.rootDirectory
  }

  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`${project.name}: ${res.status} ${JSON.stringify(data)}`)
  }

  console.log(`✓ ${project.name}`)
  console.log(`    build: ${project.buildCommand.slice(0, 60)}...`)
  return data
}

async function main() {
  const token = getToken()
  console.log('Syncing Vercel project settings…\n')
  for (const project of PROJECTS) {
    await patchProject(project, token)
  }
  console.log('\nDone. Dashboard settings now match repo vercel.json.')
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
