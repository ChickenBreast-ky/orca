import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

type DaemonServerWithClients = {
  readonly clients: ReadonlyMap<string, unknown>
}

describe('DaemonServer product identity', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-pid-test-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a copied-token client with another product identity before it is tracked', async () => {
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => {
        throw new Error('PTY spawn is outside this handshake test')
      }
    })
    await server.start()
    const wrongProductClient = new DaemonClient({
      socketPath,
      tokenPath,
      daemonProductIdentity: {
        appId: 'com.orca.official',
        buildVersion: '1.4.0',
        protocolVersion: PROTOCOL_VERSION
      }
    })

    await expect(wrongProductClient.ensureConnected()).rejects.toThrow('Product identity mismatch')
    expect((server as unknown as DaemonServerWithClients).clients.size).toBe(0)
    wrongProductClient.disconnect()
  })
})
