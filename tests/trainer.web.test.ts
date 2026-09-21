/** Scripted model transport exercises real Web RPC, eval subprocesses and local Git integration. */
import { it } from 'vitest'
import { verifyTraining } from './trainer-web-verification.js'
it('diagnoses two sessions, gets one plan approval, assesses artifacts and merges autonomously through public Web RPC', () => verifyTraining(true), 240000)
