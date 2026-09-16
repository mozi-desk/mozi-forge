/** Scripted model transport exercises real Web RPC, eval subprocesses and local Git integration. */
import { it } from 'vitest'
import { verifyTraining } from './trainer-web-verification.js'
it('diagnoses two sessions, revises reviewed proposals, evaluates and merges through public Web RPC', () => verifyTraining(true), 240000)
