import type { PluginBackendContextV1 } from '../types/tuq-plugin-sdk.js'

export declare const GENERATED_FROM: string

export type TestSurface = 'view' | 'backend'

export type TestEnvelope = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

export interface TestClock {
  now(): number
  later(run: () => void, ms: number): { cancel(): void }
  advance(ms: number): void
}

export declare function createManualClock(start?: number): TestClock

export declare class TestHostNotModeled extends Error {
  readonly surface: string
  readonly id: string
  readonly reason: string | null
}

export declare class TestHostRefused extends Error {}

export declare class TestHostInvalid extends Error {
  readonly issues: readonly string[]
}

export type AiScriptEntry =
  | 'completed'
  | 'interrupted'
  | { readonly textDelta: string }
  | { readonly contentSaved: number }
  | { readonly failed: { readonly code: string; readonly retryable?: boolean; readonly fallbackUsed?: boolean; readonly partialDelivered?: boolean } }

export interface AiTurnScript {
  readonly events: readonly AiScriptEntry[]
}

export interface AiControls {
  next(script: AiTurnScript | readonly AiScriptEntry[]): void
  setProviderState(state: unknown): void
  usage(): unknown
  openSessions(): string[]
}

export interface TestCallRecord {
  readonly seq: number
  readonly at: number
  readonly surface: TestSurface
  readonly id: string
  readonly args: unknown
  readonly reply: TestEnvelope
  readonly injected: boolean
}

export interface TestDelivery {
  readonly surface: TestSurface
  readonly sessionId: string
  readonly turnId: string
  readonly event: { readonly kind: string; readonly [key: string]: unknown }
}

export interface TestEvent {
  readonly surface: TestSurface
  readonly id: string
  readonly value: unknown
  readonly at: number
}

export interface TestHostOptions {
  readonly manifest: Readonly<Record<string, unknown>>
  readonly grants?: readonly string[]
  readonly visible?: boolean
  readonly clock?: TestClock
  readonly limits?: Readonly<Record<string, number>>
  readonly provider?: unknown
  readonly pluginStateAuthority?: 'core' | 'sqlite'
}

export interface TestHost {
  readonly view: Window['tuqPlugin']
  readonly backend: PluginBackendContextV1
  readonly manifest: Readonly<Record<string, unknown>>
  readonly clock: TestClock
  readonly ai: AiControls
  inject(surface: TestSurface, endpointId: string, code: string, times?: number): void
  setBackendHandler(method: string, handle: (params: unknown) => unknown | Promise<unknown>): void
  grant(permission: string): Promise<void>
  revoke(permission: string): Promise<void>
  disable(): Promise<void>
  enable(): Promise<void>
  grants(): readonly string[]
  setVisible(visible: boolean): void
  userInput(input: { readonly text: string }): void
  advance(ms: number): void
  calls(filter?: string): readonly TestCallRecord[]
  deliveries(surface?: TestSurface): readonly TestDelivery[]
  events(): readonly TestEvent[]
  close(): void
}

export declare function createTestHost(options: TestHostOptions): TestHost
